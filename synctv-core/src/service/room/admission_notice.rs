//! Best-effort reports of people and TVs entering a room through an invite link or pairing.
//!
//! Reports are sent from a spawned task after the admission has committed: looking up names
//! and delivering the report can neither slow down nor fail the join or the pairing.

use async_trait::async_trait;

use crate::models::{RoomId, UserId};

use super::RoomService;

/// An admission worth telling the operator about, with names resolved for display.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoomAdmissionEvent {
    /// Someone joined a room through an invite link.
    InviteRedeemed {
        room_id: RoomId,
        room_name: String,
        user_id: UserId,
        display_name: String,
    },
    /// A TV was paired to a room.
    TvPaired {
        room_id: RoomId,
        room_name: String,
        tv_user_id: UserId,
        claimer_id: UserId,
        claimer_name: String,
    },
}

/// Receives [`RoomAdmissionEvent`]s. Implementations should not fail loudly: errors are theirs
/// to log, and the admission they report has already happened.
#[async_trait]
pub trait RoomAdmissionNotifier: Send + Sync {
    async fn notify(&self, event: RoomAdmissionEvent);
}

/// What the room service knows at admission time; names are resolved in the spawned task.
pub(super) enum AdmissionNotice {
    InviteRedeemed {
        room_id: RoomId,
        user_id: UserId,
        display_name: String,
    },
    TvPaired {
        room_id: RoomId,
        tv_user_id: UserId,
        claimer_id: UserId,
    },
}

impl RoomService {
    /// Hand `notice` to the admission notifier, if any, without waiting for it.
    pub(super) fn notify_admission(&self, notice: AdmissionNotice) {
        let Some(notifier) = self.admission_notifier.clone() else {
            return;
        };
        let room_repo = self.room_repo.clone();
        let user_service = self.user_service.clone();
        crate::spawn::spawn_monitored("room_admission_notice", async move {
            let room_name = |room_id: RoomId| {
                let room_repo = room_repo.clone();
                async move {
                    match room_repo.get_by_id(&room_id).await {
                        Ok(Some(room)) => room.name,
                        Ok(None) => format!("room {room_id}"),
                        Err(error) => {
                            tracing::debug!(error = %error, room_id = %room_id, "Room lookup for admission notice failed");
                            format!("room {room_id}")
                        }
                    }
                }
            };
            let event = match notice {
                AdmissionNotice::InviteRedeemed {
                    room_id,
                    user_id,
                    display_name,
                } => RoomAdmissionEvent::InviteRedeemed {
                    room_id,
                    room_name: room_name(room_id).await,
                    user_id,
                    display_name,
                },
                AdmissionNotice::TvPaired {
                    room_id,
                    tv_user_id,
                    claimer_id,
                } => {
                    let claimer_name = match user_service.get_user(&claimer_id).await {
                        Ok(user) => user.username,
                        Err(error) => {
                            tracing::debug!(error = %error, user_id = %claimer_id, "User lookup for admission notice failed");
                            format!("user {claimer_id}")
                        }
                    };
                    RoomAdmissionEvent::TvPaired {
                        room_id,
                        room_name: room_name(room_id).await,
                        tv_user_id,
                        claimer_id,
                        claimer_name,
                    }
                }
            };
            notifier.notify(event).await;
        });
    }
}
