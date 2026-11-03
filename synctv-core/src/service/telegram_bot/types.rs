//! The subset of the Telegram Bot API types the bot reads and writes.
//!
//! Unknown fields are ignored on input; optional fields are omitted on output.

use serde::{Deserialize, Serialize};

/// `{"ok": bool, "result": T, ...}` envelope of every Bot API response.
#[derive(Debug, Deserialize)]
pub(crate) struct ApiResponse<T> {
    pub ok: bool,
    pub result: Option<T>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub error_code: Option<i64>,
    #[serde(default)]
    pub parameters: Option<ResponseParameters>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ResponseParameters {
    #[serde(default)]
    pub retry_after: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Update {
    pub update_id: i64,
    #[serde(default)]
    pub message: Option<Message>,
    #[serde(default)]
    pub callback_query: Option<CallbackQuery>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Message {
    pub message_id: i64,
    #[serde(default)]
    pub from: Option<User>,
    pub chat: Chat,
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct User {
    pub id: i64,
    #[serde(default)]
    pub is_bot: bool,
    #[serde(default)]
    pub first_name: String,
    #[serde(default)]
    pub username: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Chat {
    pub id: i64,
    #[serde(rename = "type", default)]
    pub kind: String,
}

impl Chat {
    #[must_use]
    pub fn is_private(&self) -> bool {
        self.kind == "private"
    }
}

/// The message a callback button was attached to. Telegram may send an "inaccessible
/// message" here (old messages); both shapes carry the chat and message id.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct CallbackMessage {
    pub message_id: i64,
    pub chat: Chat,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct CallbackQuery {
    pub id: String,
    pub from: User,
    #[serde(default)]
    pub message: Option<CallbackMessage>,
    #[serde(default)]
    pub data: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WebAppInfo {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct InlineKeyboardButton {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_app: Option<WebAppInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callback_data: Option<String>,
}

impl InlineKeyboardButton {
    #[must_use]
    pub fn web_app(text: impl Into<String>, url: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            web_app: Some(WebAppInfo { url: url.into() }),
            url: None,
            callback_data: None,
        }
    }

    #[must_use]
    pub fn url(text: impl Into<String>, url: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            web_app: None,
            url: Some(url.into()),
            callback_data: None,
        }
    }

    #[must_use]
    pub fn callback(text: impl Into<String>, data: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            web_app: None,
            url: None,
            callback_data: Some(data.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct InlineKeyboardMarkup {
    pub inline_keyboard: Vec<Vec<InlineKeyboardButton>>,
}

/// A reply the bot sends: plain text (no parse mode, so nothing needs escaping) and an
/// optional inline keyboard.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SendMessage {
    pub chat_id: i64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_markup: Option<InlineKeyboardMarkup>,
}

impl SendMessage {
    #[must_use]
    pub fn text(chat_id: i64, text: impl Into<String>) -> Self {
        Self {
            chat_id,
            text: text.into(),
            reply_markup: None,
        }
    }

    #[must_use]
    pub fn with_keyboard(mut self, rows: Vec<Vec<InlineKeyboardButton>>) -> Self {
        if !rows.is_empty() {
            self.reply_markup = Some(InlineKeyboardMarkup {
                inline_keyboard: rows,
            });
        }
        self
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct GetUpdates<'a> {
    pub offset: i64,
    pub timeout: u64,
    pub allowed_updates: &'a [&'a str],
}

#[derive(Debug, Serialize)]
pub(crate) struct AnswerCallbackQuery<'a> {
    pub callback_query_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<&'a str>,
}

#[derive(Debug, Serialize)]
pub(crate) struct SetChatMenuButton<'a> {
    pub menu_button: MenuButtonWebApp<'a>,
}

#[derive(Debug, Serialize)]
pub(crate) struct MenuButtonWebApp<'a> {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub text: &'a str,
    pub web_app: WebAppInfo,
}

#[derive(Debug, Serialize)]
pub(crate) struct Empty {}
