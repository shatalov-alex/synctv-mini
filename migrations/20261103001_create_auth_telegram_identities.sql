-- Telegram Mini App sign-in: a verified Telegram account maps to one SyncTV user.
-- Tokens issued through it carry a `telegram` credential binding; refresh requires the
-- mapping to still exist, so deleting a row signs that Telegram account out everywhere.
CREATE TABLE IF NOT EXISTS auth_telegram_identities (
    telegram_user_id BIGINT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    first_name VARCHAR(255) NOT NULL DEFAULT '',
    username VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auth_telegram_identities_user_id
    ON auth_telegram_identities(user_id);

CREATE TRIGGER update_auth_telegram_identities_updated_at
    BEFORE UPDATE ON auth_telegram_identities
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
