//! Service API key (`service_api` config section): lets another app on the internal network
//! call the HTTP API as one configured user with `Authorization: Bearer stk_...`.
//!
//! Only a SHA-256 of the key is kept; presented keys are hashed and compared in constant time.
//! Keyed requests are refused when they came through the Cloudflare tunnel or from a socket
//! peer outside `allowed_networks`.

use std::net::IpAddr;

use ipnet::IpNet;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

pub const SERVICE_API_KEY_PREFIX: &str = "stk_";
pub const SERVICE_API_KEY_MIN_LEN: usize = 36;
/// Fewest different characters after the prefix. A random hex key has about 16; a typed
/// placeholder such as `stk_aaaa...` or `stk_1234...1234` has few.
pub const SERVICE_API_KEY_MIN_DISTINCT_CHARS: usize = 12;

/// Headers a proxy adds to the requests it forwards: the Cloudflare tunnel's, and the ones
/// nginx, Caddy, Traefik and the like set. Their peer is local, but the caller is not.
pub const PROXIED_REQUEST_HEADERS: [&str; 5] = [
    "cf-ray",
    "cf-connecting-ip",
    "x-forwarded-for",
    "x-real-ip",
    "forwarded",
];

/// Loopback, RFC 1918 and unique-local IPv6: the networks a sibling Docker container uses.
pub const DEFAULT_SERVICE_API_ALLOWED_NETWORKS: [&str; 6] = [
    "127.0.0.0/8",
    "::1/128",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "fc00::/7",
];

/// SHA-256 of the configured key.
#[derive(Clone)]
pub struct ServiceApiKeyHash([u8; 32]);

impl ServiceApiKeyHash {
    /// Validate the configured key's shape and keep only its hash.
    pub fn from_key(key: &str) -> Result<Self, String> {
        if !key.starts_with(SERVICE_API_KEY_PREFIX) {
            return Err(format!(
                "service_api.key must start with \"{SERVICE_API_KEY_PREFIX}\""
            ));
        }
        if key.len() < SERVICE_API_KEY_MIN_LEN {
            return Err(format!(
                "service_api.key must be at least {SERVICE_API_KEY_MIN_LEN} characters"
            ));
        }
        if !key.bytes().all(|byte| byte.is_ascii_graphic()) {
            return Err("service_api.key must be printable ASCII without spaces".to_string());
        }
        let distinct = key[SERVICE_API_KEY_PREFIX.len()..]
            .bytes()
            .collect::<std::collections::HashSet<_>>()
            .len();
        if distinct < SERVICE_API_KEY_MIN_DISTINCT_CHARS {
            return Err(
                "service_api.key looks like a placeholder: generate one with \"stk_$(openssl rand -hex 32)\""
                    .to_string(),
            );
        }
        Ok(Self(Sha256::digest(key.as_bytes()).into()))
    }

    #[must_use]
    pub fn matches(&self, presented: &str) -> bool {
        let presented: [u8; 32] = Sha256::digest(presented.as_bytes()).into();
        presented.ct_eq(&self.0).into()
    }
}

impl std::fmt::Debug for ServiceApiKeyHash {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ServiceApiKeyHash(<redacted>)")
    }
}

/// `service_api.act_as`: `telegram_admin` or a username.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServiceApiActAs {
    TelegramAdmin,
    Username(String),
}

impl ServiceApiActAs {
    pub const TELEGRAM_ADMIN: &'static str = "telegram_admin";

    #[must_use]
    pub fn parse(value: &str) -> Self {
        let value = value.trim();
        if value.is_empty() || value == Self::TELEGRAM_ADMIN {
            Self::TelegramAdmin
        } else {
            Self::Username(value.to_string())
        }
    }

    /// The core lookup for this setting; `telegram_admin` uses the `telegram` section.
    #[must_use]
    pub fn lookup<'a>(
        &'a self,
        telegram_admin_user_id: i64,
        telegram_admin_username: &'a str,
    ) -> synctv_core::service::ServiceApiActAs<'a> {
        match self {
            Self::TelegramAdmin => synctv_core::service::ServiceApiActAs::TelegramAdmin {
                admin_telegram_user_id: telegram_admin_user_id,
                admin_username: telegram_admin_username,
            },
            Self::Username(username) => synctv_core::service::ServiceApiActAs::Username(username),
        }
    }

    #[must_use]
    pub fn describe(&self) -> String {
        match self {
            Self::TelegramAdmin => Self::TELEGRAM_ADMIN.to_string(),
            Self::Username(username) => format!("user \"{username}\""),
        }
    }
}

#[derive(Clone, Debug)]
pub struct ServiceApiSettings {
    /// `None` = keyed requests are refused (no key configured).
    pub key_hash: Option<ServiceApiKeyHash>,
    pub act_as: ServiceApiActAs,
    pub allowed_networks: Vec<IpNet>,
}

impl Default for ServiceApiSettings {
    fn default() -> Self {
        Self {
            key_hash: None,
            act_as: ServiceApiActAs::TelegramAdmin,
            allowed_networks: default_service_api_allowed_networks(),
        }
    }
}

impl ServiceApiSettings {
    #[must_use]
    pub const fn enabled(&self) -> bool {
        self.key_hash.is_some()
    }

    #[must_use]
    pub fn peer_allowed(&self, peer_ip: IpAddr) -> bool {
        let peer_ip = peer_ip.to_canonical();
        self.allowed_networks
            .iter()
            .any(|network| network.contains(&peer_ip))
    }
}

#[must_use]
pub fn default_service_api_allowed_networks() -> Vec<IpNet> {
    DEFAULT_SERVICE_API_ALLOWED_NETWORKS
        .iter()
        .filter_map(|network| network.parse().ok())
        .collect()
}

/// Parse `service_api.allowed_networks` entries (CIDR or bare IP).
pub fn parse_service_api_networks(networks: &[String]) -> Result<Vec<IpNet>, String> {
    networks
        .iter()
        .map(|network| {
            let network = network.trim();
            network
                .parse::<IpNet>()
                .or_else(|_| network.parse::<IpAddr>().map(IpNet::from))
                .map_err(|_| {
                    format!("service_api.allowed_networks entry '{network}' is not a CIDR or IP")
                })
        })
        .collect()
}

/// The key from an `Authorization: Bearer stk_...` header, or `None` for any other header
/// (JWTs and other schemes keep their usual path).
#[must_use]
pub fn service_api_key_from_authorization(authorization: &str) -> Option<&str> {
    let (scheme, credentials) = authorization.trim().split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let credentials = credentials.trim();
    credentials
        .starts_with(SERVICE_API_KEY_PREFIX)
        .then_some(credentials)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "stk_0123456789abcdef0123456789abcdef0123";

    #[test]
    fn key_must_have_prefix_and_length() {
        assert!(ServiceApiKeyHash::from_key(KEY).is_ok());
        assert!(ServiceApiKeyHash::from_key("stk_short").is_err());
        assert!(ServiceApiKeyHash::from_key("key_0123456789abcdef0123456789abcdef0123").is_err());
        assert!(ServiceApiKeyHash::from_key("stk_0123456789abcdef 0123456789abcdef0123").is_err());
    }

    #[test]
    fn key_must_not_be_a_placeholder() {
        assert!(ServiceApiKeyHash::from_key(&format!("stk_{}", "a".repeat(40))).is_err());
        assert!(ServiceApiKeyHash::from_key(&format!("stk_{}", "1234".repeat(10))).is_err());
    }

    #[test]
    fn key_hash_matches_only_the_same_key() {
        let hash = ServiceApiKeyHash::from_key(KEY).expect("valid key");
        assert!(hash.matches(KEY));
        assert!(!hash.matches("stk_0123456789abcdef0123456789abcdef0124"));
        assert!(!format!("{hash:?}").contains("0123"));
    }

    #[test]
    fn bearer_parsing_only_picks_service_keys() {
        assert_eq!(
            service_api_key_from_authorization(&format!("Bearer {KEY}")),
            Some(KEY)
        );
        assert_eq!(
            service_api_key_from_authorization(&format!("bearer {KEY}")),
            Some(KEY)
        );
        assert_eq!(
            service_api_key_from_authorization("Bearer eyJhbGciOi"),
            None
        );
        assert_eq!(
            service_api_key_from_authorization(&format!("Basic {KEY}")),
            None
        );
    }

    #[test]
    fn default_networks_cover_docker_and_loopback_only() {
        let settings = ServiceApiSettings::default();
        for allowed in [
            "127.0.0.1",
            "172.18.0.5",
            "10.1.2.3",
            "192.168.1.9",
            "::1",
            "fd00::1",
        ] {
            assert!(
                settings.peer_allowed(allowed.parse().expect("ip")),
                "{allowed} should be allowed"
            );
        }
        for denied in ["8.8.8.8", "172.32.0.1", "2001:db8::1"] {
            assert!(
                !settings.peer_allowed(denied.parse().expect("ip")),
                "{denied} should be denied"
            );
        }
        assert!(settings.peer_allowed("::ffff:172.18.0.5".parse().expect("ip")));
    }

    #[test]
    fn act_as_parsing() {
        assert_eq!(ServiceApiActAs::parse(""), ServiceApiActAs::TelegramAdmin);
        assert_eq!(
            ServiceApiActAs::parse("telegram_admin"),
            ServiceApiActAs::TelegramAdmin
        );
        assert_eq!(
            ServiceApiActAs::parse(" bot "),
            ServiceApiActAs::Username("bot".to_string())
        );
    }

    #[test]
    fn network_parsing_accepts_cidrs_and_ips() {
        let networks =
            parse_service_api_networks(&["10.0.0.0/8".to_string(), "192.168.1.7".to_string()])
                .expect("valid networks");
        assert_eq!(networks.len(), 2);
        assert!(parse_service_api_networks(&["nope".to_string()]).is_err());
    }
}
