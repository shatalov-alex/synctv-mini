//! Room invite link repository (`room_invites`). Tokens are stored as sha256 only.

use chrono::{DateTime, Utc};
use sqlx::PgPool;

use crate::{
    models::{RoomId, UserId},
    Result,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomInvite {
    pub id: i64,
    pub room_id: RoomId,
    pub created_by: UserId,
    pub expires_at: Option<DateTime<Utc>>,
    pub max_uses: Option<i32>,
    pub uses: i32,
    pub revoked_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

impl RoomInvite {
    /// Whether the invite can still admit a new member at `now`.
    #[must_use]
    pub fn is_usable(&self, now: DateTime<Utc>) -> bool {
        self.revoked_at.is_none()
            && self.expires_at.is_none_or(|expires_at| expires_at > now)
            && self.max_uses.is_none_or(|max_uses| self.uses < max_uses)
    }
}

#[derive(Clone)]
pub struct RoomInviteRepository {
    pool: PgPool,
}

impl RoomInviteRepository {
    #[must_use]
    pub const fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn create(
        &self,
        room_id: &RoomId,
        created_by: &UserId,
        token_hash: &[u8],
        expires_at: Option<DateTime<Utc>>,
        max_uses: Option<i32>,
    ) -> Result<RoomInvite> {
        let invite = sqlx::query_as!(
            RoomInvite,
            r#"
            INSERT INTO room_invites (room_id, created_by, token_hash, expires_at, max_uses)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, room_id AS "room_id: RoomId", created_by AS "created_by: UserId",
                      expires_at, max_uses, uses, revoked_at, created_at
            "#,
            room_id.as_i64(),
            created_by.as_i64(),
            token_hash,
            expires_at,
            max_uses,
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(invite)
    }

    pub async fn find_by_token_hash(&self, token_hash: &[u8]) -> Result<Option<RoomInvite>> {
        let invite = sqlx::query_as!(
            RoomInvite,
            r#"
            SELECT id, room_id AS "room_id: RoomId", created_by AS "created_by: UserId",
                   expires_at, max_uses, uses, revoked_at, created_at
            FROM room_invites
            WHERE token_hash = $1
            "#,
            token_hash,
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(invite)
    }

    /// Atomically spend one use. False if the invite is revoked, expired, or used up.
    pub async fn consume(&self, invite_id: i64) -> Result<bool> {
        let result = sqlx::query!(
            r#"
            UPDATE room_invites
            SET uses = uses + 1
            WHERE id = $1
              AND revoked_at IS NULL
              AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
              AND (max_uses IS NULL OR uses < max_uses)
            "#,
            invite_id,
        )
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Give back a use spent by a redemption that then failed.
    pub async fn release(&self, invite_id: i64) -> Result<()> {
        sqlx::query!(
            "UPDATE room_invites SET uses = uses - 1 WHERE id = $1 AND uses > 0",
            invite_id,
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_for_room(&self, room_id: &RoomId) -> Result<Vec<RoomInvite>> {
        let invites = sqlx::query_as!(
            RoomInvite,
            r#"
            SELECT id, room_id AS "room_id: RoomId", created_by AS "created_by: UserId",
                   expires_at, max_uses, uses, revoked_at, created_at
            FROM room_invites
            WHERE room_id = $1
            ORDER BY created_at DESC
            "#,
            room_id.as_i64(),
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(invites)
    }

    /// Revoke one invite (`Some(id)`) or every live invite of the room (`None`).
    /// Returns how many were revoked.
    pub async fn revoke(&self, room_id: &RoomId, invite_id: Option<i64>) -> Result<u64> {
        let result = sqlx::query!(
            r#"
            UPDATE room_invites
            SET revoked_at = CURRENT_TIMESTAMP
            WHERE room_id = $1
              AND revoked_at IS NULL
              AND ($2::BIGINT IS NULL OR id = $2)
            "#,
            room_id.as_i64(),
            invite_id,
        )
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }
}
