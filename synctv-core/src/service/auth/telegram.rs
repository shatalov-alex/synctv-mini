//! Telegram Mini App `initData` verification.
//!
//! See <https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app>:
//! the data-check string is every field except `hash`, sorted by key and joined as `key=value`
//! lines; the key is `HMAC-SHA256(key = "WebAppData", message = bot_token)`.

use hmac::{Hmac, KeyInit, Mac};
use serde::Deserialize;
use sha2::Sha256;

use crate::{Error, Result};

type HmacSha256 = Hmac<Sha256>;

/// The verified parts of a Mini App launch that the server acts on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TelegramInitData {
    pub user_id: i64,
    pub first_name: String,
    pub last_name: Option<String>,
    pub username: Option<String>,
    /// `startapp` payload of a `t.me/<bot>/<app>?startapp=...` link, if any.
    pub start_param: Option<String>,
    pub auth_date: i64,
}

#[derive(Deserialize)]
struct TelegramUserField {
    id: i64,
    #[serde(default)]
    first_name: String,
    last_name: Option<String>,
    username: Option<String>,
}

fn invalid() -> Error {
    Error::Authentication("Invalid Telegram init data".to_string())
}

/// Verify `init_data` (the raw `Telegram.WebApp.initData` query string) against `bot_token`.
///
/// Rejects a bad signature, a missing user, and an `auth_date` older than `max_age_secs`
/// (or more than a minute in the future).
pub fn verify_init_data(
    init_data: &str,
    bot_token: &str,
    now_unix: i64,
    max_age_secs: i64,
) -> Result<TelegramInitData> {
    if bot_token.is_empty() {
        return Err(Error::Authentication(
            "Telegram login is not configured".to_string(),
        ));
    }

    let mut hash: Option<Vec<u8>> = None;
    let mut fields: Vec<(String, String)> = Vec::new();
    for (key, value) in url::form_urlencoded::parse(init_data.as_bytes()) {
        if key == "hash" {
            if hash.is_some() {
                return Err(invalid());
            }
            hash = Some(hex::decode(value.as_bytes()).map_err(|_| invalid())?);
        } else {
            fields.push((key.into_owned(), value.into_owned()));
        }
    }
    let hash = hash.ok_or_else(invalid)?;
    fields.sort_by(|a, b| a.0.cmp(&b.0));
    let data_check_string = fields
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("\n");

    let mut secret = HmacSha256::new_from_slice(b"WebAppData").map_err(|_| invalid())?;
    secret.update(bot_token.as_bytes());
    let secret_key = secret.finalize().into_bytes();
    let mut mac = HmacSha256::new_from_slice(&secret_key).map_err(|_| invalid())?;
    mac.update(data_check_string.as_bytes());
    mac.verify_slice(&hash).map_err(|_| invalid())?;

    let field = |name: &str| {
        fields
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    };
    let auth_date: i64 = field("auth_date")
        .and_then(|v| v.parse().ok())
        .ok_or_else(invalid)?;
    if now_unix.saturating_sub(auth_date) > max_age_secs || auth_date > now_unix + 60 {
        return Err(Error::Authentication(
            "Telegram init data expired".to_string(),
        ));
    }
    let user: TelegramUserField =
        serde_json::from_str(field("user").ok_or_else(invalid)?).map_err(|_| invalid())?;

    Ok(TelegramInitData {
        user_id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        username: user.username,
        start_param: field("start_param").map(str::to_string),
        auth_date,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOT_TOKEN: &str = "123456:test-token";
    const NOW: i64 = 1_800_000_000;

    fn sign(fields: &[(&str, &str)], bot_token: &str) -> String {
        let mut sorted: Vec<_> = fields.to_vec();
        sorted.sort_by(|a, b| a.0.cmp(b.0));
        let dcs = sorted
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("\n");
        let mut secret = HmacSha256::new_from_slice(b"WebAppData").expect("hmac accepts any key");
        secret.update(bot_token.as_bytes());
        let key = secret.finalize().into_bytes();
        let mut mac = HmacSha256::new_from_slice(&key).expect("hmac accepts any key");
        mac.update(dcs.as_bytes());
        let hash = hex::encode(mac.finalize().into_bytes());
        let mut out = url::form_urlencoded::Serializer::new(String::new());
        for (k, v) in fields {
            out.append_pair(k, v);
        }
        out.append_pair("hash", &hash);
        out.finish()
    }

    fn launch(auth_date: i64) -> String {
        sign(
            &[
                ("auth_date", &auth_date.to_string()),
                ("query_id", "AAH"),
                ("start_param", "inv_abc"),
                ("user", r#"{"id":42,"first_name":"Alex","username":"alex"}"#),
            ],
            BOT_TOKEN,
        )
    }

    #[test]
    fn accepts_a_fresh_correctly_signed_launch() {
        let data = verify_init_data(&launch(NOW - 10), BOT_TOKEN, NOW, 3600)
            .expect("fresh signed launch should verify");
        assert_eq!(data.user_id, 42);
        assert_eq!(data.first_name, "Alex");
        assert_eq!(data.username.as_deref(), Some("alex"));
        assert_eq!(data.start_param.as_deref(), Some("inv_abc"));
    }

    #[test]
    fn rejects_another_bots_signature() {
        assert!(verify_init_data(&launch(NOW), "999:other", NOW, 3600).is_err());
    }

    #[test]
    fn rejects_tampered_fields() {
        let tampered = launch(NOW).replace("%22id%22%3A42", "%22id%22%3A43");
        assert_ne!(tampered, launch(NOW));
        assert!(verify_init_data(&tampered, BOT_TOKEN, NOW, 3600).is_err());
    }

    #[test]
    fn rejects_stale_and_future_launches() {
        assert!(verify_init_data(&launch(NOW - 3601), BOT_TOKEN, NOW, 3600).is_err());
        assert!(verify_init_data(&launch(NOW + 120), BOT_TOKEN, NOW, 3600).is_err());
    }

    #[test]
    fn rejects_missing_hash_user_or_bot_token() {
        assert!(verify_init_data("auth_date=1&user=%7B%7D", BOT_TOKEN, NOW, 3600).is_err());
        let no_user = sign(&[("auth_date", &NOW.to_string())], BOT_TOKEN);
        assert!(verify_init_data(&no_user, BOT_TOKEN, NOW, 3600).is_err());
        assert!(verify_init_data(&launch(NOW), "", NOW, 3600).is_err());
    }
}
