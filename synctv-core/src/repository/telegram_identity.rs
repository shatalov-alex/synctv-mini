//! Telegram identity repository
//!
//! Maps a verified Telegram account to a local user (`auth_telegram_identities`).

use crate::{models::UserId, Result};
use sqlx::PgPool;

#[derive(Clone)]
pub struct TelegramIdentityRepository {
    pool: PgPool,
}

impl TelegramIdentityRepository {
    #[must_use]
    pub const fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// The user a Telegram account is mapped to, if any.
    pub async fn find_user_id(&self, telegram_user_id: i64) -> Result<Option<UserId>> {
        let user_id = sqlx::query_scalar!(
            r#"
            SELECT user_id AS "user_id: UserId"
            FROM auth_telegram_identities
            WHERE telegram_user_id = $1
            "#,
            telegram_user_id,
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(user_id)
    }

    /// Map `telegram_user_id` to `user_id`, refreshing the display fields if already mapped.
    pub async fn upsert(
        &self,
        telegram_user_id: i64,
        user_id: &UserId,
        first_name: &str,
        username: Option<&str>,
    ) -> Result<()> {
        sqlx::query!(
            r#"
            INSERT INTO auth_telegram_identities (telegram_user_id, user_id, first_name, username)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (telegram_user_id) DO UPDATE
               SET user_id = EXCLUDED.user_id,
                   first_name = EXCLUDED.first_name,
                   username = EXCLUDED.username
            "#,
            telegram_user_id,
            user_id.as_i64(),
            first_name,
            username,
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Unlink every Telegram account of `user_id` except `keep_telegram_user_id`, which signs
    /// those accounts out (their tokens fail the binding check on refresh). Returns rows removed.
    pub async fn delete_others_for_user(
        &self,
        user_id: &UserId,
        keep_telegram_user_id: i64,
    ) -> Result<u64> {
        let result = sqlx::query!(
            r#"
            DELETE FROM auth_telegram_identities
            WHERE user_id = $1 AND telegram_user_id <> $2
            "#,
            user_id.as_i64(),
            keep_telegram_user_id,
        )
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }
}
