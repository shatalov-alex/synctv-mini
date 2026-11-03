//! Room invite links against a real database (testcontainers PG): creator-only management,
//! single-use admission as a playback-only room admin, re-entry and revocation.

use synctv_core::{
    models::{RoomPermission, RoomRole},
    service::{RoomService, TelegramInitData, UserService},
};
use synctv_core_testing::{
    create_test_pool, create_test_room_service, create_test_user_service, TestOptionExt,
    TestResultExt,
};

fn telegram_user(id: i64, first_name: &str) -> TelegramInitData {
    TelegramInitData {
        user_id: id,
        first_name: first_name.to_string(),
        username: None,
        start_param: None,
        auth_date: 0,
    }
}

async fn setup() -> (
    synctv_core_testing::TestContainer,
    UserService,
    RoomService,
    synctv_core::models::User,
    synctv_core::models::Room,
) {
    let (container, pool) = create_test_pool().await;
    let users = create_test_user_service(pool.clone());
    let rooms = create_test_room_service(pool);
    let creator = users
        .find_or_create_telegram_user(&telegram_user(1, "Alex"))
        .await
        .checked("creator should be created");
    let room = rooms
        .create_room(
            "Evening movie".to_string(),
            String::new(),
            creator.id,
            None,
            None,
        )
        .await
        .checked("room should be created");
    (container, users, rooms, creator, room)
}

#[tokio::test]
#[ignore = "Requires Docker-backed PostgreSQL"]
async fn single_use_invite_admits_one_guest_with_playback_control_only() {
    let (_container, users, rooms, creator, room) = Box::pin(setup()).await;

    let (invite, token) = rooms
        .create_room_invite(room.id, creator.id, None, Some(1))
        .await
        .checked("creator should create an invite");
    assert_eq!(token.len(), 43);
    let found = rooms
        .find_room_invite(&token)
        .await
        .checked("lookup")
        .checked("invite should be found by token");
    assert_eq!(found.id, invite.id);
    assert!(rooms
        .find_room_invite("not-a-token")
        .await
        .checked("lookup")
        .is_none());

    let guest = users
        .find_or_create_telegram_user(&telegram_user(2, "Olena"))
        .await
        .checked("guest should be created");
    assert!(rooms
        .admit_invited_member(&found, guest.id, "Olena".to_string())
        .await
        .checked("guest should be admitted"));

    let effective = rooms
        .permission_service()
        .get_user_permissions_no_cache(&room.id, &guest.id)
        .await
        .checked("permissions");
    for allowed in [
        RoomPermission::CONTROL_PLAYBACK_STATE,
        RoomPermission::NAVIGATE_PLAYBACK,
        RoomPermission::SEND_CHAT_MESSAGES,
    ] {
        assert!(effective.has(allowed), "guest should have {allowed:?}");
    }
    for denied in [
        RoomPermission::ADD_MEMBERS,
        RoomPermission::REMOVE_MEMBERS,
        RoomPermission::MANAGE_MEMBER_PERMISSIONS,
        RoomPermission::MANAGE_ROOM_SETTINGS,
        RoomPermission::DELETE_MEDIA,
        RoomPermission::CLEAR_MEDIA,
    ] {
        assert!(!effective.has(denied), "guest must not have {denied:?}");
    }
    let member = rooms
        .get_member(&room.id, &guest.id)
        .await
        .checked("member lookup")
        .checked("guest should be a member");
    assert_eq!(member.role, RoomRole::Admin);
    assert_eq!(member.remark_name, "Olena");

    // The same guest may reopen the spent link; it costs no use.
    let reopened = rooms
        .find_room_invite(&token)
        .await
        .checked("lookup")
        .checked("invite");
    assert!(!rooms
        .admit_invited_member(&reopened, guest.id, "Olena".to_string())
        .await
        .checked("member should be let through"));

    // Anyone else is turned away.
    let other = users
        .find_or_create_telegram_user(&telegram_user(3, "Eve"))
        .await
        .checked("other user");
    assert!(rooms
        .admit_invited_member(&reopened, other.id, "Eve".to_string())
        .await
        .is_err());
    assert!(rooms
        .get_member(&room.id, &other.id)
        .await
        .checked("member lookup")
        .is_none());
}

#[tokio::test]
#[ignore = "Requires Docker-backed PostgreSQL"]
async fn only_the_creator_manages_invites_and_revoked_links_admit_nobody() {
    let (_container, users, rooms, creator, room) = Box::pin(setup()).await;
    let stranger = users
        .find_or_create_telegram_user(&telegram_user(9, "Mallory"))
        .await
        .checked("stranger");
    assert!(rooms
        .create_room_invite(room.id, stranger.id, None, None)
        .await
        .is_err());

    let (_invite, token) = rooms
        .create_room_invite(room.id, creator.id, None, None)
        .await
        .checked("unlimited invite");
    assert!(rooms.list_room_invites(room.id, stranger.id).await.is_err());
    assert_eq!(
        rooms
            .revoke_room_invites(room.id, creator.id, None)
            .await
            .checked("revoke"),
        1
    );
    let revoked = rooms
        .find_room_invite(&token)
        .await
        .checked("lookup")
        .checked("invite");
    assert!(rooms
        .admit_invited_member(&revoked, stranger.id, "Mallory".to_string())
        .await
        .is_err());
}

#[tokio::test]
#[ignore = "Requires Docker-backed PostgreSQL"]
async fn telegram_users_are_found_again_by_id() {
    let (_container, users, _rooms, creator, _room) = Box::pin(setup()).await;
    let again = users
        .find_or_create_telegram_user(&telegram_user(1, "Alex renamed"))
        .await
        .checked("same telegram id");
    assert_eq!(again.id, creator.id);
    assert_eq!(again.username, "tg_1");
}
