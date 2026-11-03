//! Minimal Telegram Bot API client.
//!
//! Every method URL contains the bot token (`<base>/bot<token>/<method>`), so neither the URL
//! nor a `reqwest` error that carries it is ever logged or returned: errors are stripped of
//! their URL before they leave this module.

use std::time::Duration;

use serde::{de::DeserializeOwned, Serialize};

use super::types::{
    AnswerCallbackQuery, ApiResponse, Empty, GetUpdates, MenuButtonWebApp, SendMessage,
    SetChatMenuButton, Update, User, WebAppInfo,
};

pub const DEFAULT_TELEGRAM_API_BASE_URL: &str = "https://api.telegram.org";

/// Timeout for ordinary (non long-poll) calls.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// Extra time a long poll may take beyond its server-side `timeout`.
const LONG_POLL_GRACE: Duration = Duration::from_secs(10);

#[derive(Debug, thiserror::Error)]
pub enum TelegramApiError {
    /// Network failure or timeout (URL stripped).
    #[error("Telegram request failed: {0}")]
    Transport(String),
    /// The Bot API answered `ok: false`.
    #[error("Telegram API error {code}: {description}")]
    Api {
        code: i64,
        description: String,
        retry_after: Option<u64>,
    },
    #[error("Unexpected Telegram response: {0}")]
    Decode(String),
}

impl TelegramApiError {
    /// Seconds Telegram asked us to wait (HTTP 429 flood control), if any.
    #[must_use]
    pub const fn retry_after(&self) -> Option<u64> {
        match self {
            Self::Api { retry_after, .. } => *retry_after,
            _ => None,
        }
    }

    fn transport(error: reqwest::Error) -> Self {
        Self::Transport(error.without_url().to_string())
    }
}

#[derive(Clone)]
pub struct TelegramBotApi {
    client: reqwest::Client,
    /// `<base>/bot<token>`: secret, never logged.
    method_base: String,
}

impl std::fmt::Debug for TelegramBotApi {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TelegramBotApi").finish_non_exhaustive()
    }
}

impl TelegramBotApi {
    /// Build a client for `bot_token` against `api_base_url` (empty = the public Bot API).
    pub fn new(api_base_url: &str, bot_token: &str) -> crate::Result<Self> {
        let base = api_base_url.trim().trim_end_matches('/');
        let base = if base.is_empty() {
            DEFAULT_TELEGRAM_API_BASE_URL
        } else {
            base
        };
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|error| {
                crate::Error::Internal(format!(
                    "Failed to build Telegram HTTP client: {}",
                    error.without_url()
                ))
            })?;
        Ok(Self {
            client,
            method_base: format!("{base}/bot{bot_token}"),
        })
    }

    async fn call<B: Serialize + Sync, T: DeserializeOwned>(
        &self,
        method: &str,
        body: &B,
        timeout: Option<Duration>,
    ) -> Result<T, TelegramApiError> {
        let mut request = self
            .client
            .post(format!("{}/{method}", self.method_base))
            .json(body);
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        let response = request.send().await.map_err(TelegramApiError::transport)?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(TelegramApiError::transport)?;
        let parsed: ApiResponse<T> = serde_json::from_slice(&bytes).map_err(|error| {
            TelegramApiError::Decode(format!("{method}: HTTP {status}: {error}"))
        })?;
        if !parsed.ok {
            return Err(TelegramApiError::Api {
                code: parsed
                    .error_code
                    .unwrap_or_else(|| i64::from(status.as_u16())),
                description: parsed.description.unwrap_or_default(),
                retry_after: parsed.parameters.and_then(|p| p.retry_after),
            });
        }
        parsed
            .result
            .ok_or_else(|| TelegramApiError::Decode(format!("{method}: missing result")))
    }

    pub async fn get_me(&self) -> Result<User, TelegramApiError> {
        self.call("getMe", &Empty {}, None).await
    }

    /// Long-poll for updates after `offset`, waiting up to `timeout_secs` on the server.
    pub async fn get_updates(
        &self,
        offset: i64,
        timeout_secs: u64,
    ) -> Result<Vec<Update>, TelegramApiError> {
        self.call(
            "getUpdates",
            &GetUpdates {
                offset,
                timeout: timeout_secs,
                allowed_updates: &["message", "callback_query"],
            },
            Some(Duration::from_secs(timeout_secs) + LONG_POLL_GRACE),
        )
        .await
    }

    pub async fn send_message(&self, message: &SendMessage) -> Result<(), TelegramApiError> {
        let _: serde_json::Value = self.call("sendMessage", message, None).await?;
        Ok(())
    }

    pub async fn answer_callback_query(
        &self,
        callback_query_id: &str,
        text: Option<&str>,
    ) -> Result<(), TelegramApiError> {
        let _: bool = self
            .call(
                "answerCallbackQuery",
                &AnswerCallbackQuery {
                    callback_query_id,
                    text,
                },
                None,
            )
            .await?;
        Ok(())
    }

    /// Set the default chat menu button (all private chats) to open `url` as a Mini App.
    pub async fn set_web_app_menu_button(
        &self,
        text: &str,
        url: &str,
    ) -> Result<(), TelegramApiError> {
        let _: bool = self
            .call(
                "setChatMenuButton",
                &SetChatMenuButton {
                    menu_button: MenuButtonWebApp {
                        kind: "web_app",
                        text,
                        web_app: WebAppInfo {
                            url: url.to_string(),
                        },
                    },
                },
                None,
            )
            .await?;
        Ok(())
    }
}
