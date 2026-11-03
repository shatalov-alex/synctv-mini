//! Telegram bot chat: `/start` opens the Mini App, `/invite` lets the admin create room invite
//! links, and the admin is told when someone joins through an invite or a TV is paired.
//!
//! - [`api`]: Bot API client (the token never appears in logs or errors).
//! - [`handler`]: update routing and replies.
//! - [`poller`]: `getUpdates` long polling with backoff and cancellation.
//! - [`notifier`]: [`crate::service::RoomAdmissionNotifier`] that messages the admin.

pub mod api;
pub mod handler;
pub mod notifier;
pub mod poller;
pub mod types;

pub use api::{TelegramApiError, TelegramBotApi, DEFAULT_TELEGRAM_API_BASE_URL};
pub use handler::{
    decode_callback_data, encode_invite_callback, mini_app_link, parse_command, route_update,
    BotCommand, CallbackAction, Route, TelegramBot, MAX_CALLBACK_DATA_LEN, MAX_INVITE_ROOMS,
};
pub use notifier::TelegramAdminNotifier;
pub use poller::{run_polling, LONG_POLL_TIMEOUT_SECS};

/// What the bot needs from the `telegram` config section.
#[derive(Clone, Default)]
pub struct TelegramBotConfig {
    pub bot_token: String,
    /// Bot API base URL; empty = [`DEFAULT_TELEGRAM_API_BASE_URL`].
    pub api_base_url: String,
    /// Telegram id allowed to use admin commands; 0 = nobody.
    pub admin_user_id: i64,
    /// Local admin account used when the admin's Telegram id is not mapped to an admin.
    pub admin_username: String,
    /// Mini App URL for the `web_app` button and menu button; `None` = not configured.
    pub web_app_url: Option<String>,
}

impl TelegramBotConfig {
    #[must_use]
    pub const fn is_admin(&self, telegram_user_id: i64) -> bool {
        self.admin_user_id != 0 && telegram_user_id == self.admin_user_id
    }
}

impl std::fmt::Debug for TelegramBotConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TelegramBotConfig")
            .field("bot_token", &"<redacted>")
            .field("api_base_url", &self.api_base_url)
            .field("admin_user_id", &self.admin_user_id)
            .field("admin_username", &self.admin_username)
            .field("web_app_url", &self.web_app_url)
            .finish()
    }
}
