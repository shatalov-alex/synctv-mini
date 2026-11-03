//! Telegram Mini App admin sign-in against a real database (testcontainers PG).

use std::sync::Arc;

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use sqlx::PgPool;
use synctv_core::{
    cache::{KeyBuilder, UsernameCache},
    models::{SignupMethod, User, UserRole},
    repository::{TelegramIdentityRepository, UserRepository},
    service::{
        AuthenticatedLogin, BruteForceProtection, InMemoryTokenBlacklistStore, JwtService,
        TelegramAdminLogin, TokenBlacklistStore, UserService, UserServiceRuntimeOptions,
    },
};
use synctv_core_testing::{create_test_pool, TestResultExt};

const BOT_TOKEN: &str = "123456:telegram-auth-test-token";
const ADMIN_TG_ID: i64 = 4242;

fn user_service(pool: &PgPool) -> UserService {
    let jwt = JwtService::with_durations(
        "test-secret-key-for-telegram-auth-tests-long-enough-1234567890",
        1,
        30,
        4,
        60,
    )
    .checked("jwt service");
    let token_blacklist: Arc<dyn TokenBlacklistStore> =
        Arc::new(InMemoryTokenBlacklistStore::new(10_000, 3600, 86400));
    UserService::new_with_runtime(
        pool,
        jwt,
        UsernameCache::local_only("test:username:".to_string(), 1000, 0),
        token_blacklist,
        KeyBuilder::new("test"),
        BruteForceProtection::in_memory("test".to_string()),
        UserServiceRuntimeOptions::test_defaults(),
    )
}

async fn create_user(pool: &PgPool, role: UserRole) -> User {
    let mut user = User::new(
        format!("tg_{}", synctv_common::snanoid!(8)).to_lowercase(),
        SignupMethod::AdminCreated,
    );
    user.role = role;
    UserRepository::new(pool.clone())
        .create(&user)
        .await
        .checked("user should be created")
}

fn init_data(telegram_user_id: i64) -> String {
    let auth_date = chrono::Utc::now().timestamp().to_string();
    let user = format!(r#"{{"id":{telegram_user_id},"first_name":"Alex","username":"alex"}}"#);
    let mut fields = vec![("auth_date", auth_date.as_str()), ("user", user.as_str())];
    fields.sort_by(|a, b| a.0.cmp(b.0));
    let dcs = fields
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut secret = Hmac::<Sha256>::new_from_slice(b"WebAppData").checked("hmac key");
    secret.update(BOT_TOKEN.as_bytes());
    let key = secret.finalize().into_bytes();
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).checked("hmac key");
    mac.update(dcs.as_bytes());
    let mut out = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in &fields {
        out.append_pair(k, v);
    }
    out.append_pair("hash", &hex::encode(mac.finalize().into_bytes()));
    out.finish()
}

fn login(admin_username: &str, admin_telegram_user_id: i64) -> TelegramAdminLogin<'_> {
    TelegramAdminLogin {
        bot_token: BOT_TOKEN,
        admin_telegram_user_id,
        admin_username,
        init_data_max_age_secs: 3600,
    }
}

#[tokio::test]
#[ignore = "Requires Docker-backed PostgreSQL"]
async fn admin_signs_in_and_refreshes_while_mapped() {
    let (_container, pool) = create_test_pool().await;
    let service = user_service(&pool);
    let admin = create_user(&pool, UserRole::Root).await;

    let outcome = service
        .login_with_telegram_admin_with_control(
            &init_data(ADMIN_TG_ID),
            &login(&admin.username, ADMIN_TG_ID),
            None,
            None,
        )
        .await
        .checked("admin telegram login should succeed");
    let AuthenticatedLogin::Complete {
        user,
        refresh_token,
        ..
    } = outcome
    else {
        std::panic::panic_any("telegram login should not require MFA");
    };
    assert_eq!(user.id, admin.id);

    let mapped = TelegramIdentityRepository::new(pool.clone())
        .find_user_id(ADMIN_TG_ID)
        .await
        .checked("lookup");
    assert_eq!(mapped, Some(admin.id));

    let (_access, rotated) = service
        .refresh_token(refresh_token)
        .await
        .checked("refresh should succeed while the mapping exists");

    // The admin Telegram id changes: the new id signs in, the old one is unlinked, and the
    // old session can no longer refresh.
    service
        .login_with_telegram_admin_with_control(
            &init_data(ADMIN_TG_ID + 1),
            &login(&admin.username, ADMIN_TG_ID + 1),
            None,
            None,
        )
        .await
        .checked("new admin telegram id should sign in");
    assert!(service.refresh_token(rotated).await.is_err());
}

#[tokio::test]
#[ignore = "Requires Docker-backed PostgreSQL"]
async fn other_telegram_users_and_non_admin_targets_are_rejected() {
    let (_container, pool) = create_test_pool().await;
    let service = user_service(&pool);
    let admin = create_user(&pool, UserRole::Root).await;
    let regular = create_user(&pool, UserRole::User).await;
    let identities = TelegramIdentityRepository::new(pool.clone());

    let stranger = service
        .login_with_telegram_admin_with_control(
            &init_data(999),
            &login(&admin.username, ADMIN_TG_ID),
            None,
            None,
        )
        .await;
    assert!(stranger.is_err());
    assert_eq!(identities.find_user_id(999).await.checked("lookup"), None);

    let not_admin = service
        .login_with_telegram_admin_with_control(
            &init_data(ADMIN_TG_ID),
            &login(&regular.username, ADMIN_TG_ID),
            None,
            None,
        )
        .await;
    assert!(not_admin.is_err());

    let disabled = service
        .login_with_telegram_admin_with_control(
            &init_data(ADMIN_TG_ID),
            &login(&admin.username, 0),
            None,
            None,
        )
        .await;
    assert!(disabled.is_err());

    let forged = init_data(ADMIN_TG_ID).replace("Alex", "Eve");
    let forged = service
        .login_with_telegram_admin_with_control(
            &forged,
            &login(&admin.username, ADMIN_TG_ID),
            None,
            None,
        )
        .await;
    assert!(forged.is_err());
}
