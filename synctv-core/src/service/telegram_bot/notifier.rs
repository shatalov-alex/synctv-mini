//! Messages the configured Telegram admin about invite joins and TV pairings.

use async_trait::async_trait;

use crate::service::{RoomAdmissionEvent, RoomAdmissionNotifier};

use super::{api::TelegramBotApi, types::SendMessage};

/// Sends each [`RoomAdmissionEvent`] to `admin_chat_id` (the admin's Telegram id, which is
/// also their private chat id with the bot). Delivery failures are logged and dropped.
pub struct TelegramAdminNotifier {
    api: TelegramBotApi,
    admin_chat_id: i64,
}

impl TelegramAdminNotifier {
    #[must_use]
    pub const fn new(api: TelegramBotApi, admin_chat_id: i64) -> Self {
        Self { api, admin_chat_id }
    }

    #[must_use]
    pub fn message_text(event: &RoomAdmissionEvent) -> String {
        match event {
            RoomAdmissionEvent::InviteRedeemed {
                room_name,
                display_name,
                ..
            } => format!("{display_name} joined \u{201c}{room_name}\u{201d} with an invite link."),
            RoomAdmissionEvent::TvPaired {
                room_name,
                claimer_name,
                ..
            } => format!("A TV was paired to \u{201c}{room_name}\u{201d} by {claimer_name}."),
        }
    }
}

#[async_trait]
impl RoomAdmissionNotifier for TelegramAdminNotifier {
    async fn notify(&self, event: RoomAdmissionEvent) {
        if self.admin_chat_id == 0 {
            return;
        }
        let message = SendMessage::text(self.admin_chat_id, Self::message_text(&event));
        if let Err(error) = self.api.send_message(&message).await {
            tracing::warn!(error = %error, "Failed to notify the Telegram admin");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{RoomId, UserId};

    #[test]
    fn describes_admissions() {
        let room_id = RoomId::try_from(3_i64).unwrap_or_default();
        let user_id = UserId::try_from(4_i64).unwrap_or_default();
        assert_eq!(
            TelegramAdminNotifier::message_text(&RoomAdmissionEvent::InviteRedeemed {
                room_id,
                room_name: "Movie night".to_string(),
                user_id,
                display_name: "Olena".to_string(),
            }),
            "Olena joined \u{201c}Movie night\u{201d} with an invite link."
        );
        assert_eq!(
            TelegramAdminNotifier::message_text(&RoomAdmissionEvent::TvPaired {
                room_id,
                room_name: "Movie night".to_string(),
                tv_user_id: user_id,
                claimer_id: user_id,
                claimer_name: "alex".to_string(),
            }),
            "A TV was paired to \u{201c}Movie night\u{201d} by alex."
        );
    }
}
