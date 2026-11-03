//! `getUpdates` long polling.
//!
//! Only one process may poll a bot at a time (Telegram answers a second poller with 409), so
//! the caller runs this as a leader-gated singleton. Updates are acknowledged by the next
//! `getUpdates` offset; one cut short by shutdown or a leadership change is redelivered to
//! the next poller.

use std::{sync::Arc, time::Duration};

use tokio_util::sync::CancellationToken;

use crate::service::{RoomService, UserService};

use super::{
    api::{TelegramApiError, TelegramBotApi},
    handler::TelegramBot,
    TelegramBotConfig,
};

/// Server-side wait of each `getUpdates` call.
pub const LONG_POLL_TIMEOUT_SECS: u64 = 30;
const INITIAL_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// Upper bound on a flood-control `retry_after` we are willing to honour.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(300);
const MENU_BUTTON_TEXT: &str = "Open";

struct Backoff {
    next: Duration,
}

impl Backoff {
    const fn new() -> Self {
        Self {
            next: INITIAL_BACKOFF,
        }
    }

    fn reset(&mut self) {
        self.next = INITIAL_BACKOFF;
    }

    /// Delay before the next attempt after `error`; grows exponentially up to [`MAX_BACKOFF`]
    /// unless Telegram asked for a specific wait.
    fn delay_after(&mut self, error: &TelegramApiError) -> Duration {
        if let Some(secs) = error.retry_after() {
            return Duration::from_secs(secs).min(MAX_RETRY_AFTER);
        }
        let delay = self.next;
        self.next = (self.next * 2).min(MAX_BACKOFF);
        delay
    }
}

/// Sleep for `delay`; `false` if cancelled first.
async fn sleep_or_cancel(delay: Duration, cancel: &CancellationToken) -> bool {
    tokio::select! {
        () = cancel.cancelled() => false,
        () = tokio::time::sleep(delay) => true,
    }
}

/// Look the bot's username up with `getMe`, retrying with backoff. `None` if cancelled.
async fn fetch_bot_username(api: &TelegramBotApi, cancel: &CancellationToken) -> Option<String> {
    let mut backoff = Backoff::new();
    loop {
        let result = tokio::select! {
            () = cancel.cancelled() => return None,
            result = api.get_me() => result,
        };
        match result {
            Ok(me) => match me.username {
                Some(username) if !username.is_empty() => return Some(username),
                _ => {
                    tracing::error!(
                        "Telegram getMe returned no bot username; bot polling disabled"
                    );
                    return None;
                }
            },
            Err(error) => {
                let delay = backoff.delay_after(&error);
                tracing::warn!(error = %error, retry_in_secs = delay.as_secs(), "Telegram getMe failed");
                if !sleep_or_cancel(delay, cancel).await {
                    return None;
                }
            }
        }
    }
}

/// Run the bot until `cancel` fires: resolve the bot username once, point the chat menu
/// button at the Mini App (when `web_app_url` is set), then long-poll and handle updates.
pub async fn run_polling(
    api: TelegramBotApi,
    config: TelegramBotConfig,
    room_service: Arc<RoomService>,
    user_service: Arc<UserService>,
    cancel: CancellationToken,
) {
    let Some(bot_username) = fetch_bot_username(&api, &cancel).await else {
        return;
    };
    tracing::info!(bot_username = %bot_username, "Telegram bot polling started");

    if let Some(url) = &config.web_app_url {
        if let Err(error) = api.set_web_app_menu_button(MENU_BUTTON_TEXT, url).await {
            tracing::warn!(error = %error, "Failed to set the Telegram chat menu button");
        }
    }

    let bot = TelegramBot::new(
        api.clone(),
        config,
        bot_username,
        room_service,
        user_service,
    );
    let mut offset: i64 = 0;
    let mut backoff = Backoff::new();
    loop {
        let result = tokio::select! {
            () = cancel.cancelled() => break,
            result = api.get_updates(offset, LONG_POLL_TIMEOUT_SECS) => result,
        };
        let updates = match result {
            Ok(updates) => {
                backoff.reset();
                updates
            }
            Err(error) => {
                let delay = backoff.delay_after(&error);
                tracing::warn!(error = %error, retry_in_secs = delay.as_secs(), "Telegram getUpdates failed");
                if !sleep_or_cancel(delay, &cancel).await {
                    break;
                }
                continue;
            }
        };
        for update in updates {
            if cancel.is_cancelled() {
                break;
            }
            offset = offset.max(update.update_id.saturating_add(1));
            if let Err(error) = bot.handle_update(&update).await {
                tracing::warn!(error = %error, update_id = update.update_id, "Telegram update handling failed");
            }
        }
    }
    tracing::info!("Telegram bot polling stopped");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transport() -> TelegramApiError {
        TelegramApiError::Transport("down".to_string())
    }

    #[test]
    fn backoff_grows_caps_and_resets() {
        let mut backoff = Backoff::new();
        let delays: Vec<u64> = (0..8)
            .map(|_| backoff.delay_after(&transport()).as_secs())
            .collect();
        assert_eq!(delays, vec![1, 2, 4, 8, 16, 32, 60, 60]);
        backoff.reset();
        assert_eq!(backoff.delay_after(&transport()), INITIAL_BACKOFF);
    }

    #[test]
    fn backoff_honours_bounded_retry_after() {
        let mut backoff = Backoff::new();
        let flood = |secs| TelegramApiError::Api {
            code: 429,
            description: "Too Many Requests".to_string(),
            retry_after: Some(secs),
        };
        assert_eq!(backoff.delay_after(&flood(7)), Duration::from_secs(7));
        assert_eq!(backoff.delay_after(&flood(100_000)), MAX_RETRY_AFTER);
        assert_eq!(backoff.delay_after(&transport()), INITIAL_BACKOFF);
    }
}
