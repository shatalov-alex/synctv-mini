//! Room invite links: managed by the room creator, redeemed from the Telegram Mini App.

use synctv_common::ExecutionControl;
use synctv_core::{models::UserId, repository::RoomInvite};
use synctv_proto::client as proto;

use super::{auth::login_outcome_to_proto, ClientApiImpl};
use crate::impls::ApiError;

const DEFAULT_INVITE_TTL_SECS: i64 = 24 * 60 * 60;
const DEFAULT_INVITE_MAX_USES: i32 = 1;

fn invite_to_proto(invite: &RoomInvite) -> proto::RoomInvite {
    proto::RoomInvite {
        id: invite.id,
        expires_at: invite.expires_at.map_or(0, |t| t.timestamp()),
        max_uses: invite.max_uses.unwrap_or(0),
        uses: invite.uses,
        revoked: invite.revoked_at.is_some(),
        created_at: invite.created_at.timestamp(),
    }
}

impl ClientApiImpl {
    pub async fn create_room_invite(
        &self,
        user_id: &UserId,
        room_id: &str,
        req: proto::CreateRoomInviteRequest,
    ) -> Result<proto::CreateRoomInviteResponse, ApiError> {
        crate::impls::validate_proto_request(&req)?;
        let rid = self.parse_room_id(room_id)?;
        let ttl_secs = if req.ttl_seconds == 0 {
            DEFAULT_INVITE_TTL_SECS
        } else {
            req.ttl_seconds
        };
        let max_uses = if req.max_uses == 0 {
            DEFAULT_INVITE_MAX_USES
        } else {
            req.max_uses
        };
        let expires_at = self.clock.now() + chrono::Duration::seconds(ttl_secs);
        let (invite, token) = self
            .room_service
            .create_room_invite(rid, *user_id, Some(expires_at), Some(max_uses))
            .await
            .map_err(Self::map_room_access_error)?;
        Ok(proto::CreateRoomInviteResponse {
            invite: Some(invite_to_proto(&invite)),
            token,
        })
    }

    pub async fn list_room_invites(
        &self,
        user_id: &UserId,
        room_id: &str,
    ) -> Result<proto::ListRoomInvitesResponse, ApiError> {
        let rid = self.parse_room_id(room_id)?;
        let invites = self
            .room_service
            .list_room_invites(rid, *user_id)
            .await
            .map_err(Self::map_room_access_error)?;
        Ok(proto::ListRoomInvitesResponse {
            invites: invites.iter().map(invite_to_proto).collect(),
        })
    }

    pub async fn revoke_room_invites(
        &self,
        user_id: &UserId,
        room_id: &str,
        req: proto::RevokeRoomInvitesRequest,
    ) -> Result<proto::RevokeRoomInvitesResponse, ApiError> {
        crate::impls::validate_proto_request(&req)?;
        let rid = self.parse_room_id(room_id)?;
        let invite_id = (req.invite_id != 0).then_some(req.invite_id);
        let revoked = self
            .room_service
            .revoke_room_invites(rid, *user_id, invite_id)
            .await
            .map_err(Self::map_room_access_error)?;
        Ok(proto::RevokeRoomInvitesResponse { revoked })
    }

    /// Redeem an invite from the Telegram Mini App: verify the launch, join the room with
    /// playback control (or just sign in if already a member), and issue tokens.
    pub async fn redeem_room_invite_with_control(
        &self,
        req: proto::RedeemRoomInviteRequest,
        client_ip: Option<std::net::IpAddr>,
        control: Option<&ExecutionControl>,
    ) -> Result<proto::RedeemRoomInviteResponse, ApiError> {
        crate::impls::validate_proto_request(&req)?;
        let telegram = &self.runtime_settings.telegram;
        if telegram.bot_token.is_empty() {
            return Err(ApiError::NotFound(
                "Telegram login is not enabled".to_string(),
            ));
        }

        let verified = self
            .user_service
            .verify_telegram_launch_with_control(
                &req.init_data,
                &telegram.bot_token,
                telegram.init_data_max_age_secs,
                client_ip,
                control,
            )
            .await
            .map_err(ApiError::from)?;
        let token = if req.token.is_empty() {
            verified.start_param.clone().unwrap_or_default()
        } else {
            req.token
        };
        let invalid = || ApiError::Authentication("This invite link is not valid".to_string());
        if token.is_empty() {
            return Err(invalid());
        }
        let invite = self
            .room_service
            .find_room_invite(&token)
            .await
            .map_err(ApiError::from)?
            .ok_or_else(invalid)?;

        let user = self
            .user_service
            .find_or_create_telegram_user(&verified)
            .await
            .map_err(ApiError::from)?;
        self.room_service
            .admit_invited_member(&invite, user.id, verified.first_name.clone())
            .await
            .map_err(Self::map_room_access_error)?;

        let outcome = self
            .user_service
            .login_with_verified_telegram_with_control(
                &user.id,
                verified.user_id,
                &format!("telegram:{}", verified.user_id),
                client_ip,
                control,
            )
            .await
            .map_err(ApiError::from)?;
        let room_id = self
            .public_id_codec
            .encode_room_id(invite.room_id)
            .map_err(|error| {
                ApiError::Internal(format!("Failed to encode room public id: {error}"))
            })?;
        Ok(proto::RedeemRoomInviteResponse {
            login: Some(login_outcome_to_proto(outcome, &self.public_id_codec)?),
            room_id,
        })
    }
}
