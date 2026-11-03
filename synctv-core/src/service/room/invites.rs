//! Room invite links: creation, listing and revocation by the room creator, and admission of
//! the person who redeems one as a room admin limited to playback control.

use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};

use crate::{
    models::{RoomAdminPermissionBits, RoomId, RoomRole, UserId},
    repository::{RoomInvite, RoomInviteRepository},
    Error, Result,
};

use super::{AddMemberWithOutboxRequest, RoomService};

/// What an invited guest may do: watch, chat, and fully control playback (play/pause, seek,
/// speed, next/previous). Everything else a room admin could do is removed.
pub const INVITED_GUEST_PERMISSIONS: u64 = RoomAdminPermissionBits::SEND_CHAT_MESSAGES
    | RoomAdminPermissionBits::MANAGE_OWN_MEDIA
    | RoomAdminPermissionBits::BROWSE_LIBRARY
    | RoomAdminPermissionBits::VIEW_MEMBERS
    | RoomAdminPermissionBits::VIEW_CHAT_HISTORY
    | RoomAdminPermissionBits::USE_VOICE_CHAT
    | RoomAdminPermissionBits::USE_P2P_MEDIA
    | RoomAdminPermissionBits::VIEW_PLAYBACK_HISTORY
    | RoomAdminPermissionBits::CONTROL_PLAYBACK_STATE
    | RoomAdminPermissionBits::NAVIGATE_PLAYBACK;

const INVITED_GUEST_REMOVED: u64 = RoomAdminPermissionBits::DEFAULT & !INVITED_GUEST_PERMISSIONS;

#[must_use]
pub fn invite_token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

impl RoomService {
    fn invites(&self) -> RoomInviteRepository {
        RoomInviteRepository::new(self.pool.clone())
    }

    /// Invites admit people as (restricted) room admins, which only the creator may confer.
    async fn ensure_invite_manager(&self, room_id: &RoomId, actor_id: &UserId) -> Result<()> {
        let room = self
            .room_repo
            .get_by_id(room_id)
            .await?
            .ok_or_else(|| Error::NotFound("Room not found".to_string()))?;
        if room.created_by != *actor_id {
            return Err(Error::Authorization(
                "Only the room creator can manage invite links".to_string(),
            ));
        }
        Ok(())
    }

    /// Create an invite link. Returns the stored invite and the token, which is not stored
    /// and cannot be shown again.
    pub async fn create_room_invite(
        &self,
        room_id: RoomId,
        actor_id: UserId,
        expires_at: Option<DateTime<Utc>>,
        max_uses: Option<i32>,
    ) -> Result<(RoomInvite, String)> {
        self.ensure_invite_manager(&room_id, &actor_id).await?;
        if max_uses.is_some_and(|max_uses| max_uses <= 0) {
            return Err(Error::InvalidInput("max_uses must be positive".to_string()));
        }
        // 43 base62 chars (~256 bits), valid as a Telegram `startapp` payload.
        let token = synctv_common::snanoid!(43);
        let invite = self
            .invites()
            .create(
                &room_id,
                &actor_id,
                &invite_token_hash(&token),
                expires_at,
                max_uses,
            )
            .await?;
        Ok((invite, token))
    }

    pub async fn list_room_invites(
        &self,
        room_id: RoomId,
        actor_id: UserId,
    ) -> Result<Vec<RoomInvite>> {
        self.ensure_invite_manager(&room_id, &actor_id).await?;
        self.invites().list_for_room(&room_id).await
    }

    /// Revoke one invite, or all of the room's invites when `invite_id` is `None`. People who
    /// already joined stay members.
    pub async fn revoke_room_invites(
        &self,
        room_id: RoomId,
        actor_id: UserId,
        invite_id: Option<i64>,
    ) -> Result<u64> {
        self.ensure_invite_manager(&room_id, &actor_id).await?;
        self.invites().revoke(&room_id, invite_id).await
    }

    pub async fn find_room_invite(&self, token: &str) -> Result<Option<RoomInvite>> {
        self.invites()
            .find_by_token_hash(&invite_token_hash(token))
            .await
    }

    /// Admit `target_user_id` through `invite`. A current member is let through without
    /// spending a use. Returns whether the user was newly added.
    pub async fn admit_invited_member(
        &self,
        invite: &RoomInvite,
        target_user_id: UserId,
        display_name: String,
    ) -> Result<bool> {
        if self
            .member_repo
            .get(&invite.room_id, &target_user_id)
            .await?
            .is_some()
        {
            return Ok(false);
        }
        let invites = self.invites();
        if !invites.consume(invite.id).await? {
            return Err(Error::Authorization(
                "This invite link has expired or was already used".to_string(),
            ));
        }

        if let Err(error) = self
            .add_member_with_outbox(AddMemberWithOutboxRequest {
                room_id: invite.room_id,
                actor_id: invite.created_by,
                target_user_id,
                role: RoomRole::Admin,
                remark_name: display_name,
                display_tag: String::new(),
                notify: false,
                outbox_event_factory: None,
            })
            .await
        {
            Self::release_invite_use(&invites, invite.id).await;
            return Err(error);
        }

        // Added as a full admin first: strip everything but playback before any token exists.
        // If that fails, the member must not stay behind as a full admin.
        if let Err(error) = self
            .set_member_permission(
                invite.room_id,
                invite.created_by,
                target_user_id,
                0,
                INVITED_GUEST_REMOVED,
            )
            .await
        {
            if let Err(leave_error) = self.leave_room(invite.room_id, target_user_id).await {
                tracing::error!(
                    error = %leave_error,
                    room_id = %invite.room_id,
                    user_id = %target_user_id,
                    "Failed to remove invited member after restricting permissions failed"
                );
            }
            Self::release_invite_use(&invites, invite.id).await;
            return Err(error);
        }
        Ok(true)
    }

    async fn release_invite_use(invites: &RoomInviteRepository, invite_id: i64) {
        if let Err(error) = invites.release(invite_id).await {
            tracing::warn!(error = %error, invite_id, "Failed to release invite use");
        }
    }
}
