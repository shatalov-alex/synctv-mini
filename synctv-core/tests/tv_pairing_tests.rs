//! TV pairing against a real database (testcontainers PG): start/poll/claim, one-time token
//! delivery, expiry, claim permissions, brute-force lockout, and unpairing.

use synctv_core::models::room_settings::TvSubtitles;
use synctv_core::{
    models::{RoomPermission, RoomRole},
    service::{
        normalize_tv_pairing_code, AuthenticatedLogin, RoomService, TelegramInitData,
        TvPairingPoll, TvPairingStart, UserService, TV_PAIRING_CODE_ALPHABET,
    },
    Error,
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

struct Fixture {
    _container: synctv_core_testing::TestContainer,
    pool: sqlx::PgPool,
    users: UserService,
    rooms: RoomService,
    creator: synctv_core::models::User,
    room: synctv_core::models::Room,
}

async fn setup() -> Fixture {
    let (container, pool) = create_test_pool().await;
    let users = create_test_user_service(pool.clone());
    let rooms = create_test_room_service(pool.clone());
    let creator = users
        .find_or_create_telegram_user(&telegram_user(1, "Alex"))
        .await
        .checked("creator should be created");
    let room = rooms
        .create_room(
            "Living room".to_string(),
            String::new(),
            creator.id,
            None,
            None,
        )
        .await
        .checked("room should be created");
    Fixture {
        _container: container,
        pool,
        users,
        rooms,
        creator,
        room,
    }
}

async fn poll(rooms: &RoomService, start: &TvPairingStart) -> TvPairingPoll {
    rooms
        .poll_tv_pairing_with_control(&start.secret, None, None)
        .await
        .checked("poll")
}

fn complete(
    poll: TvPairingPoll,
) -> (
    String,
    synctv_core::models::RoomId,
    synctv_core::models::UserId,
) {
    let TvPairingPoll::Claimed { login, room_id } = poll else {
        std::panic::panic_any(format!("expected CLAIMED, got {poll:?}"));
    };
    let AuthenticatedLogin::Complete {
        user,
        refresh_token,
        ..
    } = *login
    else {
        std::panic::panic_any("TV login should not require MFA");
    };
    (refresh_token, room_id, user.id)
}

#[test]
fn codes_are_normalized_case_insensitively() {
    assert_eq!(
        normalize_tv_pairing_code(" k7m2qx "),
        Some("K7M2QX".to_string())
    );
    assert_eq!(normalize_tv_pairing_code("K7M2Q"), None);
    assert_eq!(normalize_tv_pairing_code("K7M2Q0"), None, "0 is ambiguous");
    assert_eq!(normalize_tv_pairing_code("K7M2QI"), None, "I is ambiguous");
    for ambiguous in *b"O0I1L" {
        assert!(!TV_PAIRING_CODE_ALPHABET.contains(&ambiguous));
    }
}

#[tokio::test]
#[ignore = "Requires Docker-backed PostgreSQL"]
async fn claimed_pairing_delivers_tokens_once_to_a_restricted_room_member() {
    let f = Box::pin(setup()).await;

    let start = f.rooms.start_tv_pairing().await.checked("start");
    assert_eq!(start.code.len(), 6);
    assert_eq!(start.secret.len(), 43);
    assert_eq!(
        normalize_tv_pairing_code(&start.code).as_deref(),
        Some(start.code.as_str())
    );
    assert!(matches!(
        poll(&f.rooms, &start).await,
        TvPairingPoll::Pending
    ));
    assert!(matches!(
        f.rooms
            .poll_tv_pairing_with_control("not-the-secret", None, None)
            .await
            .checked("poll with a wrong secret"),
        TvPairingPoll::Expired
    ));

    // Claim with a lowercased code: case-insensitive.
    let tv_user_id = f
        .rooms
        .claim_tv_pairing_with_control(
            &start.code.to_lowercase(),
            f.room.id,
            f.creator.id,
            None,
            None,
        )
        .await
        .checked("creator should claim the code");
    // The code cannot be claimed twice.
    assert!(matches!(
        f.rooms
            .claim_tv_pairing_with_control(&start.code, f.room.id, f.creator.id, None, None)
            .await,
        Err(Error::NotFound(_))
    ));

    let (refresh_token, room_id, user_id) = complete(poll(&f.rooms, &start).await);
    assert_eq!(room_id, f.room.id);
    assert_eq!(user_id, tv_user_id);
    // Delivered once: the pairing is gone.
    assert!(matches!(
        poll(&f.rooms, &start).await,
        TvPairingPoll::Expired
    ));

    let tv_user = f.users.get_user(&tv_user_id).await.checked("tv user");
    assert!(tv_user.username.starts_with("tv_"), "{}", tv_user.username);
    let member = f
        .rooms
        .get_member(&f.room.id, &tv_user_id)
        .await
        .checked("member lookup")
        .checked("TV should be a member");
    assert_eq!(member.role, RoomRole::Admin);
    let effective = f
        .rooms
        .permission_service()
        .get_user_permissions_no_cache(&f.room.id, &tv_user_id)
        .await
        .checked("permissions");
    assert!(effective.has(RoomPermission::CONTROL_PLAYBACK_STATE));
    assert!(effective.has(RoomPermission::NAVIGATE_PLAYBACK));
    for denied in [
        RoomPermission::ADD_MEMBERS,
        RoomPermission::REMOVE_MEMBERS,
        RoomPermission::MANAGE_MEMBER_PERMISSIONS,
        RoomPermission::MANAGE_ROOM_SETTINGS,
        RoomPermission::DELETE_MEDIA,
    ] {
        assert!(!effective.has(denied), "TV must not have {denied:?}");
    }

    let (_access, rotated) = f
        .rooms
        .user_service()
        .refresh_token(refresh_token)
        .await
        .checked("TV refresh should work while paired");

    // Listed for the room's people, hidden from outsiders and the TV itself.
    let viewer = f
        .users
        .find_or_create_telegram_user(&telegram_user(7, "Viewer"))
        .await
        .checked("viewer should be created");
    f.rooms
        .add_member(f.room.id, f.creator.id, viewer.id, RoomRole::Member, false)
        .await
        .checked("viewer should join");
    assert_eq!(
        f.rooms
            .list_tv_devices(f.room.id, viewer.id)
            .await
            .checked("a member can list")
            .len(),
        1
    );
    let outsider = f
        .users
        .find_or_create_telegram_user(&telegram_user(8, "Outsider"))
        .await
        .checked("outsider should be created");
    assert!(matches!(
        f.rooms.list_tv_devices(f.room.id, outsider.id).await,
        Err(Error::Authorization(_))
    ));
    let tvs = f
        .rooms
        .list_tv_devices(f.room.id, f.creator.id)
        .await
        .checked("list");
    assert_eq!(tvs.len(), 1);
    assert_eq!(tvs[0].user_id, tv_user_id);
    assert_eq!(tvs[0].paired_by, Some(f.creator.id));
    assert_eq!(tvs[0].username, tv_user.username);
    assert!(matches!(
        f.rooms.list_tv_devices(f.room.id, tv_user_id).await,
        Err(Error::Authorization(_))
    ));
    assert!(matches!(
        f.rooms
            .revoke_tv_device(f.room.id, tv_user_id, tv_user_id)
            .await,
        Err(Error::Authorization(_))
    ));

    // Unpair: refresh fails, and the API layer's kick removes it from the room.
    f.rooms
        .revoke_tv_device(f.room.id, f.creator.id, tv_user_id)
        .await
        .checked("creator should unpair the TV");
    assert!(f.rooms.user_service().refresh_token(rotated).await.is_err());
    f.rooms
        .kick_member(f.room.id, f.creator.id, tv_user_id, 60)
        .await
        .checked("kick the unpaired TV");
    assert!(f
        .rooms
        .get_member(&f.room.id, &tv_user_id)
        .await
        .checked("member lookup")
        .is_none());
    assert!(f
        .rooms
        .list_tv_devices(f.room.id, f.creator.id)
        .await
        .checked("list")
        .is_empty());
    assert!(matches!(
        f.rooms
            .revoke_tv_device(f.room.id, f.creator.id, tv_user_id)
            .await,
        Err(Error::NotFound(_))
    ));
}

#[tokio::test]
#[ignore = "Requires Docker-backed PostgreSQL"]
async fn expired_pairings_cannot_be_claimed_or_polled() {
    let f = Box::pin(setup()).await;
    let start = f.rooms.start_tv_pairing().await.checked("start");
    sqlx::query("UPDATE tv_pairings SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'")
        .execute(&f.pool)
        .await
        .checked("expire pairing");

    assert!(matches!(
        f.rooms
            .claim_tv_pairing_with_control(&start.code, f.room.id, f.creator.id, None, None)
            .await,
        Err(Error::NotFound(_))
    ));
    assert!(matches!(
        poll(&f.rooms, &start).await,
        TvPairingPoll::Expired
    ));

    // A claimed pairing that the TV never picked up in time delivers nothing either.
    let start = f.rooms.start_tv_pairing().await.checked("start");
    f.rooms
        .claim_tv_pairing_with_control(&start.code, f.room.id, f.creator.id, None, None)
        .await
        .checked("claim");
    sqlx::query("UPDATE tv_pairings SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'")
        .execute(&f.pool)
        .await
        .checked("expire claimed pairing");
    assert!(matches!(
        poll(&f.rooms, &start).await,
        TvPairingPoll::Expired
    ));
}

#[tokio::test]
#[ignore = "Requires Docker-backed PostgreSQL"]
async fn only_members_with_playback_control_may_claim() {
    let f = Box::pin(setup()).await;
    let start = f.rooms.start_tv_pairing().await.checked("start");

    let stranger = f
        .users
        .find_or_create_telegram_user(&telegram_user(9, "Mallory"))
        .await
        .checked("stranger");
    assert!(matches!(
        f.rooms
            .claim_tv_pairing_with_control(&start.code, f.room.id, stranger.id, None, None)
            .await,
        Err(Error::Authorization(_))
    ));
    // Permission denial does not consume the code.
    assert!(matches!(
        poll(&f.rooms, &start).await,
        TvPairingPoll::Pending
    ));

    // An invited guest has playback control and may pair a TV.
    let guest = f
        .users
        .find_or_create_telegram_user(&telegram_user(2, "Olena"))
        .await
        .checked("guest");
    let (invite, _token) = f
        .rooms
        .create_room_invite(f.room.id, f.creator.id, None, Some(1))
        .await
        .checked("invite");
    f.rooms
        .admit_invited_member(&invite, guest.id, "Olena".to_string())
        .await
        .checked("guest admitted");
    let tv_user_id = f
        .rooms
        .claim_tv_pairing_with_control(&start.code, f.room.id, guest.id, None, None)
        .await
        .checked("guest should claim");
    let (_refresh, room_id, user_id) = complete(poll(&f.rooms, &start).await);
    assert_eq!((room_id, user_id), (f.room.id, tv_user_id));
    let tvs = f
        .rooms
        .list_tv_devices(f.room.id, f.creator.id)
        .await
        .checked("list");
    assert_eq!(tvs[0].paired_by, Some(guest.id));
}

#[tokio::test]
#[ignore = "Requires Docker-backed PostgreSQL"]
async fn wrong_codes_lock_the_claimer_out() {
    let f = Box::pin(setup()).await;
    let start = f.rooms.start_tv_pairing().await.checked("start");
    let wrong = if start.code == "AAAAAA" {
        "BBBBBB"
    } else {
        "AAAAAA"
    };

    for _ in 0..5 {
        assert!(matches!(
            f.rooms
                .claim_tv_pairing_with_control(wrong, f.room.id, f.creator.id, None, None)
                .await,
            Err(Error::NotFound(_))
        ));
    }
    // Locked out, even with the right code.
    assert!(matches!(
        f.rooms
            .claim_tv_pairing_with_control(&start.code, f.room.id, f.creator.id, None, None)
            .await,
        Err(Error::Authentication(_))
    ));
    assert!(matches!(
        poll(&f.rooms, &start).await,
        TvPairingPoll::Pending
    ));
}

#[tokio::test]
#[ignore = "Requires Docker-backed PostgreSQL"]
async fn the_tvs_subtitle_choice_is_open_to_whoever_controls_playback() {
    let f = Box::pin(setup()).await;
    let current = || async { f.rooms.get_room_settings(&f.room.id).await.checked("settings") };
    let english = TvSubtitles {
        enabled: true,
        track: "en|English".to_string(),
    };
    let off = TvSubtitles {
        enabled: false,
        track: "en|English".to_string(),
    };
    assert!(current().await.tv_subtitles.enabled, "on by default");

    // Other settings stay as they were.
    let before = current().await;
    let snapshot = f
        .rooms
        .set_tv_subtitles_with_outbox(f.room.id, f.creator.id, english.clone(), None)
        .await
        .checked("creator sets");
    assert_eq!(snapshot.settings.tv_subtitles, english);
    assert_eq!(snapshot.settings.max_members.0, before.max_members.0);
    assert_eq!(
        snapshot.settings.auto_play.value.enabled,
        before.auto_play.value.enabled
    );

    // An invited guest may, though not manage the room's settings.
    let guest = f
        .users
        .find_or_create_telegram_user(&telegram_user(2, "Olena"))
        .await
        .checked("guest");
    let (invite, _token) = f
        .rooms
        .create_room_invite(f.room.id, f.creator.id, None, Some(1))
        .await
        .checked("invite");
    f.rooms
        .admit_invited_member(&invite, guest.id, "Olena".to_string())
        .await
        .checked("guest admitted");
    f.rooms
        .set_tv_subtitles_with_outbox(f.room.id, guest.id, off.clone(), None)
        .await
        .checked("guest sets");
    assert_eq!(current().await.tv_subtitles, off);
    assert!(matches!(
        f.rooms
            .set_settings_with_outbox(f.room.id, guest.id, before, None)
            .await,
        Err(Error::Authorization(_))
    ));

    // So may the TV itself, for its own key.
    let start = f.rooms.start_tv_pairing().await.checked("start");
    let tv = f
        .rooms
        .claim_tv_pairing_with_control(&start.code, f.room.id, f.creator.id, None, None)
        .await
        .checked("claim");
    f.rooms
        .set_tv_subtitles_with_outbox(f.room.id, tv, english.clone(), None)
        .await
        .checked("TV sets");
    assert_eq!(current().await.tv_subtitles, english);

    // Someone outside the room may not.
    let stranger = f
        .users
        .find_or_create_telegram_user(&telegram_user(9, "Mallory"))
        .await
        .checked("stranger");
    assert!(matches!(
        f.rooms
            .set_tv_subtitles_with_outbox(f.room.id, stranger.id, off, None)
            .await,
        Err(Error::Authorization(_))
    ));
    assert_eq!(current().await.tv_subtitles, english);
}
