//! Update routing and replies.
//!
//! Routing ([`route_update`]) is pure so it can be tested without services; [`TelegramBot`]
//! executes a [`Route`] against the room and user services and the Bot API.

use std::sync::Arc;

use crate::{
    models::{PageParams, RoomId},
    service::{RoomService, UserService, DEFAULT_INVITE_MAX_USES, DEFAULT_INVITE_TTL_SECS},
    Error,
};

use super::{
    api::{TelegramApiError, TelegramBotApi},
    types::{InlineKeyboardButton, SendMessage, Update},
    TelegramBotConfig,
};

/// Telegram's limit on `callback_data`.
pub const MAX_CALLBACK_DATA_LEN: usize = 64;
/// How many of the admin's rooms `/invite` offers (newest first).
pub const MAX_INVITE_ROOMS: u32 = 10;
/// Telegram's limit on a `startapp` payload.
const MAX_START_PARAM_LEN: usize = 64;
const INVITE_CALLBACK_PREFIX: &str = "inv:";
const MAX_BUTTON_ROOM_NAME_CHARS: usize = 48;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BotCommand {
    /// `/start`, optionally with a deep-link payload (`t.me/<bot>?start=<payload>`).
    Start {
        payload: Option<String>,
    },
    Invite,
    /// Some other command addressed to this bot.
    Unknown,
}

/// Parse a command from message text. `None` for plain text and for commands addressed to a
/// different bot (`/cmd@OtherBot`).
#[must_use]
pub fn parse_command(text: &str, bot_username: &str) -> Option<BotCommand> {
    let text = text.trim_start();
    let rest = text.strip_prefix('/')?;
    let (head, args) = rest
        .split_once(char::is_whitespace)
        .map_or((rest, ""), |(head, args)| (head, args.trim()));
    let (name, target) = head
        .split_once('@')
        .map_or((head, None), |(name, target)| (name, Some(target)));
    if target.is_some_and(|target| !target.eq_ignore_ascii_case(bot_username)) {
        return None;
    }
    Some(match name.to_ascii_lowercase().as_str() {
        "start" => BotCommand::Start {
            payload: (!args.is_empty()).then(|| args.to_string()),
        },
        "invite" => BotCommand::Invite,
        _ => BotCommand::Unknown,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallbackAction {
    CreateInvite(RoomId),
}

/// Callback data for "create an invite for this room". Carries only the room id: the token
/// is created when the button is pressed and never travels through callback data.
#[must_use]
pub fn encode_invite_callback(room_id: RoomId) -> String {
    format!("{INVITE_CALLBACK_PREFIX}{}", room_id.as_i64())
}

/// Parse and validate callback data produced by [`encode_invite_callback`].
#[must_use]
pub fn decode_callback_data(data: &str) -> Option<CallbackAction> {
    if data.is_empty() || data.len() > MAX_CALLBACK_DATA_LEN {
        return None;
    }
    let digits = data.strip_prefix(INVITE_CALLBACK_PREFIX)?;
    if digits.is_empty() || digits.len() > 19 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let id: i64 = digits.parse().ok()?;
    RoomId::try_from(id).ok().map(CallbackAction::CreateInvite)
}

fn is_valid_start_param(param: &str) -> bool {
    !param.is_empty()
        && param.len() <= MAX_START_PARAM_LEN
        && param
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `https://t.me/<bot>?startapp=<param>`: opens the bot's Main Mini App with `start_param`
/// (same format as the lite client's `miniAppLink`). `None` if the username is empty or the
/// payload is not a valid `startapp` value.
#[must_use]
pub fn mini_app_link(bot_username: &str, start_param: &str) -> Option<String> {
    let bot_username = bot_username.trim_start_matches('@');
    if bot_username.is_empty() || !is_valid_start_param(start_param) {
        return None;
    }
    Some(format!(
        "https://t.me/{bot_username}?startapp={start_param}"
    ))
}

/// What to do with an update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    Start {
        chat_id: i64,
        first_name: String,
        payload: Option<String>,
    },
    Invite {
        chat_id: i64,
        from_id: i64,
    },
    Unknown {
        chat_id: i64,
    },
    Callback {
        callback_query_id: String,
        chat_id: i64,
        from_id: i64,
        data: String,
    },
    Ignore,
}

/// Decide what an update asks for. Only private chats with people are served; group
/// messages, bots and non-command text are ignored.
#[must_use]
pub fn route_update(update: &Update, bot_username: &str) -> Route {
    if let Some(query) = &update.callback_query {
        if query.from.is_bot {
            return Route::Ignore;
        }
        let chat_id = query
            .message
            .as_ref()
            .map_or(query.from.id, |message| message.chat.id);
        return Route::Callback {
            callback_query_id: query.id.clone(),
            chat_id,
            from_id: query.from.id,
            data: query.data.clone().unwrap_or_default(),
        };
    }
    let Some(message) = &update.message else {
        return Route::Ignore;
    };
    let Some(from) = &message.from else {
        return Route::Ignore;
    };
    if from.is_bot || !message.chat.is_private() {
        return Route::Ignore;
    }
    let Some(command) = message
        .text
        .as_deref()
        .and_then(|text| parse_command(text, bot_username))
    else {
        return Route::Ignore;
    };
    let chat_id = message.chat.id;
    match command {
        BotCommand::Start { payload } => Route::Start {
            chat_id,
            first_name: from.first_name.clone(),
            payload,
        },
        BotCommand::Invite => Route::Invite {
            chat_id,
            from_id: from.id,
        },
        BotCommand::Unknown => Route::Unknown { chat_id },
    }
}

#[derive(Debug, thiserror::Error)]
pub enum HandlerError {
    #[error(transparent)]
    Api(#[from] TelegramApiError),
    #[error(transparent)]
    Service(#[from] Error),
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn invite_terms() -> String {
    let hours = DEFAULT_INVITE_TTL_SECS / 3600;
    let uses = if DEFAULT_INVITE_MAX_USES == 1 {
        "single use".to_string()
    } else {
        format!("{DEFAULT_INVITE_MAX_USES} uses")
    };
    format!("valid {hours} h, {uses}")
}

/// Executes routes against the services and the Bot API.
pub struct TelegramBot {
    api: TelegramBotApi,
    config: TelegramBotConfig,
    bot_username: String,
    room_service: Arc<RoomService>,
    user_service: Arc<UserService>,
}

impl TelegramBot {
    #[must_use]
    pub const fn new(
        api: TelegramBotApi,
        config: TelegramBotConfig,
        bot_username: String,
        room_service: Arc<RoomService>,
        user_service: Arc<UserService>,
    ) -> Self {
        Self {
            api,
            config,
            bot_username,
            room_service,
            user_service,
        }
    }

    #[must_use]
    pub fn bot_username(&self) -> &str {
        &self.bot_username
    }

    /// Handle one update. Errors are for the caller to log; they never contain the token.
    pub async fn handle_update(&self, update: &Update) -> Result<(), HandlerError> {
        match route_update(update, &self.bot_username) {
            Route::Start {
                chat_id,
                first_name,
                payload,
            } => {
                self.handle_start(chat_id, &first_name, payload.as_deref())
                    .await
            }
            Route::Invite { chat_id, from_id } => self.handle_invite(chat_id, from_id).await,
            Route::Unknown { chat_id } => {
                let text = if self.config.admin_user_id == 0 {
                    "Send /start to open SyncTV."
                } else {
                    "Send /start to open SyncTV, or /invite (admin) to create a room invite link."
                };
                self.api
                    .send_message(&SendMessage::text(chat_id, text))
                    .await?;
                Ok(())
            }
            Route::Callback {
                callback_query_id,
                chat_id,
                from_id,
                data,
            } => {
                self.handle_callback(&callback_query_id, chat_id, from_id, &data)
                    .await
            }
            Route::Ignore => Ok(()),
        }
    }

    /// The `/start` reply: a greeting and a `web_app` button for the Mini App, plus a link
    /// that opens the Mini App with the deep-link payload when there is one.
    #[must_use]
    pub fn start_reply(
        &self,
        chat_id: i64,
        first_name: &str,
        payload: Option<&str>,
    ) -> SendMessage {
        let greeting = if first_name.is_empty() {
            "Hi!".to_string()
        } else {
            format!("Hi, {first_name}!")
        };
        let mut rows = Vec::new();
        let text = if let Some(url) = &self.config.web_app_url {
            rows.push(vec![InlineKeyboardButton::web_app("Open SyncTV", url)]);
            format!("{greeting} SyncTV lets you watch videos together, in sync. Tap the button below to open it.")
        } else {
            format!("{greeting} The SyncTV app isn't configured on this server yet.")
        };
        if let Some(link) = payload.and_then(|payload| mini_app_link(&self.bot_username, payload)) {
            rows.push(vec![InlineKeyboardButton::url(
                "Open this link in SyncTV",
                link,
            )]);
        }
        SendMessage::text(chat_id, text).with_keyboard(rows)
    }

    async fn handle_start(
        &self,
        chat_id: i64,
        first_name: &str,
        payload: Option<&str>,
    ) -> Result<(), HandlerError> {
        self.api
            .send_message(&self.start_reply(chat_id, first_name, payload))
            .await?;
        Ok(())
    }

    async fn admin_user(&self) -> Result<Option<crate::models::User>, Error> {
        self.user_service
            .find_telegram_admin_user(self.config.admin_user_id, &self.config.admin_username)
            .await
    }

    async fn handle_invite(&self, chat_id: i64, from_id: i64) -> Result<(), HandlerError> {
        if !self.config.is_admin(from_id) {
            self.api
                .send_message(&SendMessage::text(
                    chat_id,
                    "Sorry, only the server administrator can create invite links.",
                ))
                .await?;
            return Ok(());
        }
        let Some(admin) = self.admin_user().await? else {
            self.api
                .send_message(&SendMessage::text(
                    chat_id,
                    "No administrator account is linked to your Telegram account. Open the app once to sign in, then try again.",
                ))
                .await?;
            return Ok(());
        };
        let (rooms, _) = self
            .room_service
            .list_rooms_by_creator(&admin.id, PageParams::new(Some(1), Some(MAX_INVITE_ROOMS)))
            .await?;
        if rooms.is_empty() {
            self.api
                .send_message(&SendMessage::text(
                    chat_id,
                    "You don't have any rooms yet. Create one in the app first.",
                ))
                .await?;
            return Ok(());
        }
        let rows = rooms
            .iter()
            .map(|room| {
                vec![InlineKeyboardButton::callback(
                    truncate_chars(&room.name, MAX_BUTTON_ROOM_NAME_CHARS),
                    encode_invite_callback(room.id),
                )]
            })
            .collect();
        self.api
            .send_message(
                &SendMessage::text(
                    chat_id,
                    format!("Choose a room for the invite link ({}):", invite_terms()),
                )
                .with_keyboard(rows),
            )
            .await?;
        Ok(())
    }

    async fn handle_callback(
        &self,
        callback_query_id: &str,
        chat_id: i64,
        from_id: i64,
        data: &str,
    ) -> Result<(), HandlerError> {
        if !self.config.is_admin(from_id) {
            self.api
                .answer_callback_query(
                    callback_query_id,
                    Some("Only the server administrator can do this."),
                )
                .await?;
            return Ok(());
        }
        let Some(CallbackAction::CreateInvite(room_id)) = decode_callback_data(data) else {
            self.api
                .answer_callback_query(callback_query_id, Some("This button is no longer valid."))
                .await?;
            return Ok(());
        };
        let created = match self.admin_user().await {
            Ok(Some(admin)) => self
                .room_service
                .create_default_room_invite(room_id, admin.id)
                .await
                .map(Some),
            Ok(None) => Ok(None),
            Err(error) => Err(error),
        };
        let (invite, token) = match created {
            Ok(Some(created)) => created,
            Ok(None) => {
                self.api
                    .answer_callback_query(
                        callback_query_id,
                        Some("No administrator account is linked to your Telegram account."),
                    )
                    .await?;
                return Ok(());
            }
            Err(error) => {
                let reason = match &error {
                    Error::NotFound(message) | Error::Authorization(message) => message.clone(),
                    _ => "Something went wrong, please try again.".to_string(),
                };
                self.api
                    .answer_callback_query(
                        callback_query_id,
                        Some(&format!("Could not create the invite: {reason}")),
                    )
                    .await?;
                return Err(error.into());
            }
        };
        self.api
            .answer_callback_query(callback_query_id, Some("Invite link created"))
            .await?;

        let room_name = self
            .room_service
            .get_room(&room_id)
            .await
            .map_or_else(|_| "your room".to_string(), |room| room.name);
        let link = mini_app_link(&self.bot_username, &token).ok_or_else(|| {
            Error::Internal("Invite token is not a valid startapp payload".to_string())
        })?;
        let expiry = invite.expires_at.map_or_else(
            || "never expires".to_string(),
            |at| format!("valid until {}", at.format("%Y-%m-%d %H:%M UTC")),
        );
        let uses = invite.max_uses.map_or_else(
            || "unlimited uses".to_string(),
            |n| {
                if n == 1 {
                    "single use".to_string()
                } else {
                    format!("{n} uses")
                }
            },
        );
        self.api
            .send_message(&SendMessage::text(
                chat_id,
                format!(
                    "Invite link for \u{201c}{room_name}\u{201d}:\n{link}\n\n{expiry}, {uses}."
                ),
            ))
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOT: &str = "SyncTvBot";

    fn update(json: &str) -> Update {
        serde_json::from_str(json).expect("update should parse")
    }

    #[test]
    fn parses_commands_with_payload_and_bot_suffix() {
        assert_eq!(
            parse_command("/start", BOT),
            Some(BotCommand::Start { payload: None })
        );
        assert_eq!(
            parse_command("/start  abc_DEF-1 ", BOT),
            Some(BotCommand::Start {
                payload: Some("abc_DEF-1".to_string())
            })
        );
        assert_eq!(
            parse_command("/invite@synctvbot", BOT),
            Some(BotCommand::Invite)
        );
        assert_eq!(parse_command("/INVITE", BOT), Some(BotCommand::Invite));
        assert_eq!(parse_command("/help", BOT), Some(BotCommand::Unknown));
        assert_eq!(parse_command("/invite@OtherBot", BOT), None);
        assert_eq!(parse_command("hello /start", BOT), None);
        assert_eq!(parse_command("", BOT), None);
    }

    #[test]
    fn callback_data_round_trips_and_rejects_garbage() {
        let room_id = RoomId::try_from(1_234_567_890_123_i64).expect("room id");
        let data = encode_invite_callback(room_id);
        assert!(data.len() <= MAX_CALLBACK_DATA_LEN);
        assert_eq!(
            decode_callback_data(&data),
            Some(CallbackAction::CreateInvite(room_id))
        );
        let max = encode_invite_callback(RoomId::MAX);
        assert!(max.len() <= MAX_CALLBACK_DATA_LEN);
        assert!(decode_callback_data(&max).is_some());
        for bad in [
            "",
            "inv:",
            "inv:0",
            "inv:-5",
            "inv:+5",
            "inv:12a",
            "inv: 12",
            "inv:99999999999999999999",
            "tok:12",
            "INV:12",
        ] {
            assert_eq!(decode_callback_data(bad), None, "{bad:?}");
        }
        assert_eq!(
            decode_callback_data(&format!("inv:{}", "1".repeat(70))),
            None
        );
    }

    #[test]
    fn builds_main_mini_app_links() {
        assert_eq!(
            mini_app_link("@SyncTvBot", "abcDEF_12-x").as_deref(),
            Some("https://t.me/SyncTvBot?startapp=abcDEF_12-x")
        );
        assert_eq!(
            mini_app_link(BOT, "pair-ABC234").as_deref(),
            Some("https://t.me/SyncTvBot?startapp=pair-ABC234")
        );
        assert_eq!(mini_app_link("", "abc"), None);
        assert_eq!(mini_app_link(BOT, ""), None);
        assert_eq!(mini_app_link(BOT, "a b"), None);
        assert_eq!(mini_app_link(BOT, "a&x=1"), None);
        assert_eq!(mini_app_link(BOT, &"a".repeat(65)), None);
        let token = synctv_common::snanoid!(43);
        assert!(mini_app_link(BOT, &token).is_some());
    }

    #[test]
    fn admin_gating_requires_a_configured_matching_id() {
        let config = TelegramBotConfig {
            admin_user_id: 42,
            ..TelegramBotConfig::default()
        };
        assert!(config.is_admin(42));
        assert!(!config.is_admin(43));
        let nobody = TelegramBotConfig::default();
        assert!(!nobody.is_admin(0));
        assert!(!nobody.is_admin(42));
    }

    #[test]
    fn routes_private_commands() {
        let start = update(
            r#"{"update_id":7,"message":{"message_id":1,"date":0,"text":"/start tok_1",
                "from":{"id":5,"is_bot":false,"first_name":"Olena","language_code":"uk"},
                "chat":{"id":5,"type":"private","first_name":"Olena"}}}"#,
        );
        assert_eq!(
            route_update(&start, BOT),
            Route::Start {
                chat_id: 5,
                first_name: "Olena".to_string(),
                payload: Some("tok_1".to_string())
            }
        );
        let invite = update(
            r#"{"update_id":8,"message":{"message_id":2,"text":"/invite",
                "from":{"id":9,"is_bot":false,"first_name":"A"},"chat":{"id":9,"type":"private"}}}"#,
        );
        assert_eq!(
            route_update(&invite, BOT),
            Route::Invite {
                chat_id: 9,
                from_id: 9
            }
        );
    }

    #[test]
    fn ignores_groups_bots_plain_text_and_other_updates() {
        for json in [
            r#"{"update_id":1,"message":{"message_id":1,"text":"/start",
                "from":{"id":5,"is_bot":false,"first_name":"A"},"chat":{"id":-100,"type":"group"}}}"#,
            r#"{"update_id":2,"message":{"message_id":1,"text":"/start",
                "from":{"id":5,"is_bot":true,"first_name":"B"},"chat":{"id":5,"type":"private"}}}"#,
            r#"{"update_id":3,"message":{"message_id":1,"text":"hello",
                "from":{"id":5,"is_bot":false,"first_name":"A"},"chat":{"id":5,"type":"private"}}}"#,
            r#"{"update_id":4,"message":{"message_id":1,
                "from":{"id":5,"is_bot":false,"first_name":"A"},"chat":{"id":5,"type":"private"}}}"#,
            r#"{"update_id":5,"edited_message":{"message_id":1,"chat":{"id":5,"type":"private"}}}"#,
        ] {
            assert_eq!(route_update(&update(json), BOT), Route::Ignore, "{json}");
        }
    }

    #[test]
    fn routes_callback_queries_to_the_message_chat() {
        let query = update(
            r#"{"update_id":9,"callback_query":{"id":"cb1","chat_instance":"x","data":"inv:12",
                "from":{"id":42,"is_bot":false,"first_name":"Admin"},
                "message":{"message_id":3,"date":0,"chat":{"id":42,"type":"private"}}}}"#,
        );
        assert_eq!(
            route_update(&query, BOT),
            Route::Callback {
                callback_query_id: "cb1".to_string(),
                chat_id: 42,
                from_id: 42,
                data: "inv:12".to_string()
            }
        );
    }

    #[test]
    fn invite_terms_follow_the_shared_defaults() {
        assert_eq!(invite_terms(), "valid 24 h, single use");
    }

    #[test]
    fn truncates_long_room_names_on_char_boundaries() {
        assert_eq!(truncate_chars("short", 10), "short");
        let long = "Кіно".repeat(20);
        let cut = truncate_chars(&long, 10);
        assert_eq!(cut.chars().count(), 10);
        assert!(cut.ends_with('…'));
    }
}
