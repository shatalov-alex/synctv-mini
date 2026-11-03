//! TV pairing repositories: short-lived pairings (`tv_pairings`, secret stored as sha256 only)
//! and paired TV devices (`tv_devices`), which TV tokens are bound to.

use chrono::{DateTime, Utc};
use sqlx::PgPool;

use crate::{
    models::{RoomId, UserId},
    Result,
};

/// A pairing as seen by the TV polling with its secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TvPairing {
    pub id: i64,
    pub expires_at: DateTime<Utc>,
    pub claimed_at: Option<DateTime<Utc>>,
    /// Set once the claim finished admitting the TV.
    pub tv_user_id: Option<UserId>,
}

/// A claimed pairing taken for token delivery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsumedTvPairing {
    pub room_id: RoomId,
    pub tv_user_id: UserId,
    pub tv_device_id: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TvDevice {
    pub id: i64,
    pub user_id: UserId,
    pub room_id: RoomId,
    pub paired_by: Option<UserId>,
    pub created_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

/// A live paired TV with its user name, for listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TvDeviceSummary {
    pub id: i64,
    pub user_id: UserId,
    pub username: String,
    pub paired_by: Option<UserId>,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone)]
pub struct TvPairingRepository {
    pool: PgPool,
}

impl TvPairingRepository {
    #[must_use]
    pub const fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Insert a pairing. Returns `false` when the code is already taken.
    pub async fn create(
        &self,
        code: &str,
        secret_hash: &[u8],
        expires_at: DateTime<Utc>,
    ) -> Result<bool> {
        let result = sqlx::query!(
            r#"
            INSERT INTO tv_pairings (code, secret_hash, expires_at)
            VALUES ($1, $2, $3)
            ON CONFLICT (code) DO NOTHING
            "#,
            code,
            secret_hash,
            expires_at,
        )
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Drop pairings that expired, so their codes can be handed out again.
    pub async fn delete_expired(&self) -> Result<u64> {
        let result = sqlx::query!("DELETE FROM tv_pairings WHERE expires_at <= CURRENT_TIMESTAMP")
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected())
    }

    pub async fn find_by_secret_hash(&self, secret_hash: &[u8]) -> Result<Option<TvPairing>> {
        let pairing = sqlx::query_as!(
            TvPairing,
            r#"
            SELECT id, expires_at, claimed_at, tv_user_id AS "tv_user_id: UserId"
            FROM tv_pairings
            WHERE secret_hash = $1
            "#,
            secret_hash,
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(pairing)
    }

    /// Atomically reserve a live, unclaimed pairing by code. Returns its id.
    pub async fn reserve_by_code(&self, code: &str) -> Result<Option<i64>> {
        let id = sqlx::query_scalar!(
            r#"
            UPDATE tv_pairings
            SET claimed_at = CURRENT_TIMESTAMP
            WHERE code = $1
              AND claimed_at IS NULL
              AND expires_at > CURRENT_TIMESTAMP
            RETURNING id
            "#,
            code,
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(id)
    }

    /// Give a reserved pairing back after admitting the TV failed.
    pub async fn release(&self, pairing_id: i64) -> Result<()> {
        sqlx::query!(
            r#"
            UPDATE tv_pairings
            SET claimed_at = NULL, room_id = NULL, tv_user_id = NULL, tv_device_id = NULL
            WHERE id = $1
            "#,
            pairing_id,
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Record who the TV became, and give the TV `delivery_window_secs` to pick its tokens up.
    pub async fn complete_claim(
        &self,
        pairing_id: i64,
        room_id: &RoomId,
        tv_user_id: &UserId,
        tv_device_id: i64,
        delivery_expires_at: DateTime<Utc>,
    ) -> Result<()> {
        sqlx::query!(
            r#"
            UPDATE tv_pairings
            SET room_id = $2, tv_user_id = $3, tv_device_id = $4,
                expires_at = GREATEST(expires_at, $5)
            WHERE id = $1
            "#,
            pairing_id,
            room_id.as_i64(),
            tv_user_id.as_i64(),
            tv_device_id,
            delivery_expires_at,
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Delete a claimed, unexpired pairing and return what it was claimed for. Only one caller
    /// can ever get `Some`, which makes token delivery one-time.
    pub async fn consume_claimed(&self, pairing_id: i64) -> Result<Option<ConsumedTvPairing>> {
        let consumed = sqlx::query_as!(
            ConsumedTvPairing,
            r#"
            DELETE FROM tv_pairings
            WHERE id = $1
              AND tv_user_id IS NOT NULL
              AND expires_at > CURRENT_TIMESTAMP
            RETURNING room_id AS "room_id!: RoomId",
                      tv_user_id AS "tv_user_id!: UserId",
                      tv_device_id AS "tv_device_id!"
            "#,
            pairing_id,
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(consumed)
    }

    pub async fn delete(&self, pairing_id: i64) -> Result<()> {
        sqlx::query!("DELETE FROM tv_pairings WHERE id = $1", pairing_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

#[derive(Clone)]
pub struct TvDeviceRepository {
    pool: PgPool,
}

impl TvDeviceRepository {
    #[must_use]
    pub const fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn create(
        &self,
        user_id: &UserId,
        room_id: &RoomId,
        paired_by: &UserId,
    ) -> Result<TvDevice> {
        let device = sqlx::query_as!(
            TvDevice,
            r#"
            INSERT INTO tv_devices (user_id, room_id, paired_by)
            VALUES ($1, $2, $3)
            RETURNING id, user_id AS "user_id: UserId", room_id AS "room_id: RoomId",
                      paired_by AS "paired_by: UserId", created_at, revoked_at
            "#,
            user_id.as_i64(),
            room_id.as_i64(),
            paired_by.as_i64(),
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(device)
    }

    pub async fn get(&self, device_id: i64) -> Result<Option<TvDevice>> {
        let device = sqlx::query_as!(
            TvDevice,
            r#"
            SELECT id, user_id AS "user_id: UserId", room_id AS "room_id: RoomId",
                   paired_by AS "paired_by: UserId", created_at, revoked_at
            FROM tv_devices
            WHERE id = $1
            "#,
            device_id,
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(device)
    }

    /// Live (not revoked) TVs paired to the room, newest first.
    pub async fn list_active_for_room(&self, room_id: &RoomId) -> Result<Vec<TvDeviceSummary>> {
        let devices = sqlx::query_as!(
            TvDeviceSummary,
            r#"
            SELECT d.id, d.user_id AS "user_id: UserId", u.username,
                   d.paired_by AS "paired_by: UserId", d.created_at
            FROM tv_devices d
            JOIN users u ON u.id = d.user_id
            WHERE d.room_id = $1 AND d.revoked_at IS NULL
            ORDER BY d.created_at DESC
            "#,
            room_id.as_i64(),
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(devices)
    }

    /// Revoke the room's live TV owned by `user_id`. Returns whether one was revoked.
    pub async fn revoke(&self, room_id: &RoomId, user_id: &UserId) -> Result<bool> {
        let result = sqlx::query!(
            r#"
            UPDATE tv_devices
            SET revoked_at = CURRENT_TIMESTAMP
            WHERE room_id = $1 AND user_id = $2 AND revoked_at IS NULL
            "#,
            room_id.as_i64(),
            user_id.as_i64(),
        )
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }
}
