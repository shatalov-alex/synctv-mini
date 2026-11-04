//! TV pairing: started and polled by the TV (public), claimed by a signed-in room member,
//! listed and revoked by the room creator.

use synctv_common::ExecutionControl;
use synctv_core::{
    models::UserId,
    service::{TvPairingPoll, TV_PAIRING_POLL_INTERVAL_MS, TV_REVOKE_KICK_COOLDOWN_SECS},
};
use synctv_proto::client as proto;

use super::{auth::login_outcome_to_proto, ClientApiImpl};
use crate::impls::ApiError;

const TV_PAIRING_STATUS_PENDING: &str = "PENDING";
const TV_PAIRING_STATUS_CLAIMED: &str = "CLAIMED";
const TV_PAIRING_STATUS_EXPIRED: &str = "EXPIRED";

impl ClientApiImpl {
    pub async fn start_tv_pairing(
        &self,
        req: proto::StartTvPairingRequest,
    ) -> Result<proto::StartTvPairingResponse, ApiError> {
        crate::impls::validate_proto_request(&req)?;
        let start = self
            .room_service
            .start_tv_pairing()
            .await
            .map_err(ApiError::from)?;
        Ok(proto::StartTvPairingResponse {
            code: start.code,
            pairing_secret: start.secret,
            expires_at: start.expires_at.timestamp(),
            poll_interval_ms: TV_PAIRING_POLL_INTERVAL_MS,
        })
    }

    pub async fn poll_tv_pairing_with_control(
        &self,
        req: proto::PollTvPairingRequest,
        client_ip: Option<std::net::IpAddr>,
        control: Option<&ExecutionControl>,
    ) -> Result<proto::PollTvPairingResponse, ApiError> {
        crate::impls::validate_proto_request(&req)?;
        let poll = self
            .room_service
            .poll_tv_pairing_with_control(&req.pairing_secret, client_ip, control)
            .await
            .map_err(ApiError::from)?;
        let status_only = |status: &str| proto::PollTvPairingResponse {
            status: status.to_string(),
            login: None,
            room_id: String::new(),
        };
        match poll {
            TvPairingPoll::Pending => Ok(status_only(TV_PAIRING_STATUS_PENDING)),
            TvPairingPoll::Expired => Ok(status_only(TV_PAIRING_STATUS_EXPIRED)),
            TvPairingPoll::Claimed { login, room_id } => {
                let room_id = self
                    .public_id_codec
                    .encode_room_id(room_id)
                    .map_err(|error| {
                        ApiError::Internal(format!("Failed to encode room public id: {error}"))
                    })?;
                Ok(proto::PollTvPairingResponse {
                    status: TV_PAIRING_STATUS_CLAIMED.to_string(),
                    login: Some(login_outcome_to_proto(*login, &self.public_id_codec)?),
                    room_id,
                })
            }
        }
    }

    pub async fn claim_tv_pairing_with_control(
        &self,
        user_id: &UserId,
        req: proto::ClaimTvPairingRequest,
        client_ip: Option<std::net::IpAddr>,
        control: Option<&ExecutionControl>,
    ) -> Result<proto::ClaimTvPairingResponse, ApiError> {
        crate::impls::validate_proto_request(&req)?;
        let rid = self.parse_room_id(&req.room_id)?;
        self.room_service
            .claim_tv_pairing_with_control(&req.code, rid, *user_id, client_ip, control)
            .await
            .map_err(Self::map_room_access_error)?;
        Ok(proto::ClaimTvPairingResponse {})
    }

    pub async fn list_tv_devices(
        &self,
        user_id: &UserId,
        room_id: &str,
    ) -> Result<proto::ListTvDevicesResponse, ApiError> {
        let rid = self.parse_room_id(room_id)?;
        let devices = self
            .room_service
            .list_tv_devices(rid, *user_id)
            .await
            .map_err(Self::map_room_access_error)?;
        let encode = |id: UserId| {
            self.public_id_codec.encode_user_id(id).map_err(|error| {
                ApiError::Internal(format!("Failed to encode user public id: {error}"))
            })
        };
        let tvs = devices
            .into_iter()
            .map(|device| {
                Ok(proto::TvDevice {
                    user_id: encode(device.user_id)?,
                    name: device.username,
                    paired_at: device.created_at.timestamp(),
                    paired_by: device
                        .paired_by
                        .map(encode)
                        .transpose()?
                        .unwrap_or_default(),
                })
            })
            .collect::<Result<Vec<_>, ApiError>>()?;
        Ok(proto::ListTvDevicesResponse { tvs })
    }

    /// What the room's TVs show: for the remote, and the TV's own key.
    pub async fn set_tv_subtitles(
        &self,
        user_id: &UserId,
        room_id: &str,
        req: proto::SetTvSubtitlesRequest,
    ) -> Result<proto::SetTvSubtitlesResponse, ApiError> {
        crate::impls::validate_proto_request(&req)?;
        let rid = self.parse_room_id(room_id)?;
        let username = self.user_username_for_event(user_id).await?;
        let prepared = self
            .room_settings_fanout
            .prepare_settings_changed(&rid, user_id, &username)?;
        let snapshot = self
            .room_service
            .set_tv_subtitles_with_outbox(
                rid,
                *user_id,
                synctv_core::models::room_settings::TvSubtitles {
                    enabled: req.enabled,
                    track: req.track,
                },
                Some(prepared.settings_outbox_factory()),
            )
            .await
            .map_err(Self::map_room_access_error)?;
        let prepared = prepared
            .with_settings_and_version(&snapshot.settings, snapshot.version)
            .map_err(ApiError::from)?;
        self.room_settings_fanout
            .publish_prepared_after_outbox_commit(prepared);
        self.room_cache_fanout.publish_invalidation(&rid);
        Ok(proto::SetTvSubtitlesResponse {})
    }

    /// Unpair a TV: revoke its credentials (refresh fails from now on), then kick it from the
    /// room with the usual realtime fan-out and disconnect.
    pub async fn revoke_tv_device(
        &self,
        user_id: &UserId,
        room_id: &str,
        tv_user_id: &str,
    ) -> Result<proto::RevokeTvDeviceResponse, ApiError> {
        let rid = self.parse_room_id(room_id)?;
        let tv_uid = crate::impls::proto_validated_user_id(tv_user_id, &self.public_id_codec)?;
        self.room_service
            .revoke_tv_device(rid, *user_id, tv_uid)
            .await
            .map_err(Self::map_room_access_error)?;
        let still_member = self
            .room_service
            .get_member(&rid, &tv_uid)
            .await
            .map_err(ApiError::from)?
            .is_some();
        if still_member {
            self.kick_member(
                user_id,
                room_id,
                proto::KickMemberRequest {
                    user_id: tv_user_id.to_string(),
                    kick_cooldown_seconds: TV_REVOKE_KICK_COOLDOWN_SECS,
                },
            )
            .await?;
        }
        Ok(proto::RevokeTvDeviceResponse {})
    }
}
