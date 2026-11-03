//! TV pairing: a TV browser starts a pairing and polls with a secret; a signed-in room member
//! claims the pairing's short code for a room; the TV then receives tokens (once) for a new TV
//! user that is a member of that room with [`super::INVITED_GUEST_PERMISSIONS`].
//!
//! Pairings live in Postgres (`tv_pairings`): they survive restarts and work across replicas
//! without Redis, and the claim/delivery steps are single atomic row updates.

use std::net::IpAddr;

use chrono::{DateTime, Duration, Utc};
use sha2::{Digest, Sha256};
use synctv_common::ExecutionControl;

use crate::{
    models::{RoomId, RoomPermission, UserId},
    repository::{TvDeviceRepository, TvDeviceSummary, TvPairingRepository},
    service::user::AuthenticatedLogin,
    Error, Result,
};

use super::RoomService;

/// Unambiguous code alphabet: A-Z and 2-9 without O, 0, I, 1 and L (31 symbols).
pub const TV_PAIRING_CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
pub const TV_PAIRING_CODE_LEN: usize = 6;
pub const TV_PAIRING_TTL_SECS: i64 = 5 * 60;
pub const TV_PAIRING_POLL_INTERVAL_MS: i32 = 2000;
/// After a claim the TV gets at least this long to pick its tokens up.
const TV_PAIRING_DELIVERY_WINDOW_SECS: i64 = 2 * 60;
const TV_PAIRING_CODE_ATTEMPTS: usize = 8;
/// A revoked TV may not rejoin the room through any other path for this long.
pub const TV_REVOKE_KICK_COOLDOWN_SECS: i64 = super::MAX_KICK_COOLDOWN_SECONDS;
const TV_MEMBER_DISPLAY_NAME: &str = "TV";

#[must_use]
pub fn tv_pairing_secret_hash(secret: &str) -> Vec<u8> {
    Sha256::digest(secret.as_bytes()).to_vec()
}

/// Uppercase and trim a user-typed code; `None` if it cannot be a valid code.
#[must_use]
pub fn normalize_tv_pairing_code(code: &str) -> Option<String> {
    let code = code.trim().to_ascii_uppercase();
    (code.len() == TV_PAIRING_CODE_LEN
        && code.bytes().all(|b| TV_PAIRING_CODE_ALPHABET.contains(&b)))
    .then_some(code)
}

fn generate_tv_pairing_code() -> String {
    use rand::seq::IndexedRandom;
    let mut rng = rand::rng();
    (0..TV_PAIRING_CODE_LEN)
        .map(|_| char::from(*TV_PAIRING_CODE_ALPHABET.choose(&mut rng).unwrap_or(&b'A')))
        .collect()
}

#[derive(Debug, Clone)]
pub struct TvPairingStart {
    pub code: String,
    /// Shown only to the TV; only its sha256 is stored.
    pub secret: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug)]
pub enum TvPairingPoll {
    Pending,
    Expired,
    Claimed {
        login: Box<AuthenticatedLogin>,
        room_id: RoomId,
    },
}

impl RoomService {
    fn tv_pairings(&self) -> TvPairingRepository {
        TvPairingRepository::new(self.pool.clone())
    }

    fn tv_devices(&self) -> TvDeviceRepository {
        TvDeviceRepository::new(self.pool.clone())
    }

    /// Start a pairing: a fresh code unique among live pairings and a secret for the TV.
    pub async fn start_tv_pairing(&self) -> Result<TvPairingStart> {
        let pairings = self.tv_pairings();
        pairings.delete_expired().await?;
        let secret = synctv_common::snanoid!(43);
        let secret_hash = tv_pairing_secret_hash(&secret);
        let expires_at = self.clock.now() + Duration::seconds(TV_PAIRING_TTL_SECS);
        for _ in 0..TV_PAIRING_CODE_ATTEMPTS {
            let code = generate_tv_pairing_code();
            if pairings.create(&code, &secret_hash, expires_at).await? {
                return Ok(TvPairingStart {
                    code,
                    secret,
                    expires_at,
                });
            }
        }
        Err(Error::Internal(
            "Could not allocate a TV pairing code".to_string(),
        ))
    }

    /// Poll a pairing by its secret. Tokens are delivered exactly once: the pairing is
    /// deleted as they are issued, so later polls see `Expired`.
    pub async fn poll_tv_pairing_with_control(
        &self,
        secret: &str,
        client_ip: Option<IpAddr>,
        control: Option<&ExecutionControl>,
    ) -> Result<TvPairingPoll> {
        let pairings = self.tv_pairings();
        let Some(pairing) = pairings
            .find_by_secret_hash(&tv_pairing_secret_hash(secret))
            .await?
        else {
            return Ok(TvPairingPoll::Expired);
        };
        if pairing.expires_at <= self.clock.now() {
            pairings.delete(pairing.id).await?;
            return Ok(TvPairingPoll::Expired);
        }
        if pairing.claimed_at.is_none() || pairing.tv_user_id.is_none() {
            // Unclaimed, or a claim is still admitting the TV.
            return Ok(TvPairingPoll::Pending);
        }
        let Some(consumed) = pairings.consume_claimed(pairing.id).await? else {
            return Ok(TvPairingPoll::Expired);
        };
        let login = self
            .user_service
            .login_with_tv_device_with_control(
                &consumed.tv_user_id,
                consumed.tv_device_id,
                client_ip,
                control,
            )
            .await?;
        Ok(TvPairingPoll::Claimed {
            login: Box::new(login),
            room_id: consumed.room_id,
        })
    }

    /// Claim a pairing code for `room_id`. The claimer must be the room creator or hold
    /// `CONTROL_PLAYBACK_STATE` there. Wrong or expired codes count as brute-force failures
    /// for the claimer and the IP. Returns the new TV user.
    pub async fn claim_tv_pairing_with_control(
        &self,
        code: &str,
        room_id: RoomId,
        claimer_id: UserId,
        client_ip: Option<IpAddr>,
        control: Option<&ExecutionControl>,
    ) -> Result<UserId> {
        self.user_service
            .check_tv_pairing_claim_allowed_with_control(&claimer_id, client_ip, control)
            .await?;

        let room = self
            .room_repo
            .get_by_id(&room_id)
            .await?
            .ok_or_else(|| Error::NotFound("Room not found".to_string()))?;
        if room.created_by != claimer_id {
            self.check_permission(
                &room_id,
                &claimer_id,
                RoomPermission::CONTROL_PLAYBACK_STATE,
            )
            .await
            .map_err(|error| match error {
                Error::Authorization(_) => Error::Authorization(
                    "You need playback control in this room to pair a TV".to_string(),
                ),
                other => other,
            })?;
        }

        let pairings = self.tv_pairings();
        let reserved = match normalize_tv_pairing_code(code) {
            Some(code) => pairings.reserve_by_code(&code).await?,
            None => None,
        };
        let Some(pairing_id) = reserved else {
            self.user_service
                .record_tv_pairing_claim_failure_with_control(&claimer_id, client_ip, control)
                .await?;
            return Err(Error::NotFound(
                "Pairing code not found or expired".to_string(),
            ));
        };

        match self
            .admit_tv(pairing_id, room_id, room.created_by, claimer_id)
            .await
        {
            Ok(tv_user_id) => Ok(tv_user_id),
            Err(error) => {
                if let Err(release_error) = pairings.release(pairing_id).await {
                    tracing::warn!(
                        error = %release_error,
                        pairing_id,
                        "Failed to release TV pairing after a failed claim"
                    );
                }
                Err(error)
            }
        }
    }

    async fn admit_tv(
        &self,
        pairing_id: i64,
        room_id: RoomId,
        room_creator_id: UserId,
        claimer_id: UserId,
    ) -> Result<UserId> {
        let tv_user = self.user_service.create_tv_user().await?;
        let devices = self.tv_devices();
        let device = devices.create(&tv_user.id, &room_id, &claimer_id).await?;
        let admitted = async {
            self.admit_restricted_guest(
                room_id,
                room_creator_id,
                tv_user.id,
                TV_MEMBER_DISPLAY_NAME.to_string(),
            )
            .await?;
            let delivery_expires_at =
                self.clock.now() + Duration::seconds(TV_PAIRING_DELIVERY_WINDOW_SECS);
            self.tv_pairings()
                .complete_claim(
                    pairing_id,
                    &room_id,
                    &tv_user.id,
                    device.id,
                    delivery_expires_at,
                )
                .await
        }
        .await;
        if let Err(error) = admitted {
            if let Err(revoke_error) = devices.revoke(&room_id, &tv_user.id).await {
                tracing::error!(
                    error = %revoke_error,
                    tv_device_id = device.id,
                    "Failed to revoke TV device after a failed claim"
                );
            }
            return Err(error);
        }
        Ok(tv_user.id)
    }

    async fn ensure_tv_manager(&self, room_id: &RoomId, actor_id: &UserId) -> Result<()> {
        let room = self
            .room_repo
            .get_by_id(room_id)
            .await?
            .ok_or_else(|| Error::NotFound("Room not found".to_string()))?;
        if room.created_by != *actor_id {
            return Err(Error::Authorization(
                "Only the room creator can manage paired TVs".to_string(),
            ));
        }
        Ok(())
    }

    /// Live TVs paired to the room (room creator only).
    pub async fn list_tv_devices(
        &self,
        room_id: RoomId,
        actor_id: UserId,
    ) -> Result<Vec<TvDeviceSummary>> {
        self.ensure_tv_manager(&room_id, &actor_id).await?;
        self.tv_devices().list_active_for_room(&room_id).await
    }

    /// Revoke a paired TV's credentials (room creator only): its refresh tokens stop working.
    /// Removing it from the room is a separate kick, which the API layer performs with
    /// realtime fan-out (see [`TV_REVOKE_KICK_COOLDOWN_SECS`]).
    pub async fn revoke_tv_device(
        &self,
        room_id: RoomId,
        actor_id: UserId,
        tv_user_id: UserId,
    ) -> Result<()> {
        self.ensure_tv_manager(&room_id, &actor_id).await?;
        if !self.tv_devices().revoke(&room_id, &tv_user_id).await? {
            return Err(Error::NotFound(
                "No paired TV with this id in the room".to_string(),
            ));
        }
        Ok(())
    }
}
