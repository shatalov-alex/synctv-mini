//! Telegram bot against a local mock Bot API (axum) and a real database (testcontainers PG):
//! getUpdates -> /start -> web_app button, /invite -> callback -> invite in the DB, and admin
//! notifications for invite joins and TV pairings. Never contacts the real Telegram API.

use std::{collections::VecDeque, net::SocketAddr, sync::Arc, time::Duration};

use axum::{
    extract::{Path, State},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use synctv_core::{
    models::{SignupMethod, User, UserRole},
    repository::UserRepository,
    service::{
        telegram_bot::{run_polling, TelegramAdminNotifier, TelegramBotApi, TelegramBotConfig},
        TelegramInitData,
    },
};
use synctv_core_testing::{
    create_test_pool, create_test_room_service, create_test_user_service, TestOptionExt,
    TestResultExt,
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

const BOT_TOKEN: &str = "123456:mock-only-token";
const BOT_USERNAME: &str = "TestSyncBot";
const ADMIN_TG_ID: i64 = 4242;
const GUEST_TG_ID: i64 = 77;
const WEB_APP_URL: &str = "https://tv.example.test/";

#[derive(Clone, Default)]
struct MockTelegram {
    pending: Arc<Mutex<VecDeque<Value>>>,
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    next_update_id: Arc<Mutex<i64>>,
}

impl MockTelegram {
    async fn push_update(&self, mut update: Value) {
        let mut next = self.next_update_id.lock().await;
        *next += 1;
        update["update_id"] = json!(*next);
        self.pending.lock().await.push_back(update);
    }

    async fn calls(&self, method: &str) -> Vec<Value> {
        self.calls
            .lock()
            .await
            .iter()
            .filter(|(m, _)| m == method)
            .map(|(_, body)| body.clone())
            .collect()
    }

    /// Wait for the first `method` call whose body matches `pred`.
    async fn wait_for(&self, method: &str, pred: impl Fn(&Value) -> bool) -> Value {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(found) = self.calls(method).await.into_iter().find(|body| pred(body)) {
                return found;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for {method}; calls so far: {:?}",
                self.calls.lock().await
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

async fn mock_method(
    State(mock): State<MockTelegram>,
    Path((bot, method)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Json<Value> {
    if bot != format!("bot{BOT_TOKEN}") {
        return Json(json!({"ok": false, "error_code": 401, "description": "Unauthorized"}));
    }
    mock.calls.lock().await.push((method.clone(), body.clone()));
    let result = match method.as_str() {
        "getMe" => json!({"id": 1, "is_bot": true, "first_name": "Bot", "username": BOT_USERNAME}),
        "getUpdates" => {
            let offset = body["offset"].as_i64().unwrap_or(0);
            let mut pending = mock.pending.lock().await;
            pending.retain(|u| u["update_id"].as_i64().unwrap_or(0) >= offset);
            if pending.is_empty() {
                drop(pending);
                tokio::time::sleep(Duration::from_millis(30)).await;
                json!([])
            } else {
                Value::Array(pending.drain(..).collect())
            }
        }
        "sendMessage" => {
            json!({"message_id": 1, "date": 0, "chat": {"id": body["chat_id"], "type": "private"}})
        }
        _ => json!(true),
    };
    Json(json!({"ok": true, "result": result}))
}

async fn start_mock() -> (MockTelegram, SocketAddr) {
    let mock = MockTelegram::default();
    let app = Router::new()
        .route("/{bot}/{method}", post(mock_method))
        .with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .checked("bind mock");
    let addr = listener.local_addr().checked("mock addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (mock, addr)
}

fn message(from_id: i64, text: &str) -> Value {
    json!({"message": {
        "message_id": 1, "date": 0, "text": text,
        "from": {"id": from_id, "is_bot": false, "first_name": "Tester"},
        "chat": {"id": from_id, "type": "private"}
    }})
}

fn callback(from_id: i64, id: &str, data: &str) -> Value {
    json!({"callback_query": {
        "id": id, "chat_instance": "ci", "data": data,
        "from": {"id": from_id, "is_bot": false, "first_name": "Tester"},
        "message": {"message_id": 5, "date": 0, "chat": {"id": from_id, "type": "private"}}
    }})
}

fn text_of(body: &Value) -> &str {
    body["text"].as_str().unwrap_or_default()
}

#[tokio::test]
async fn api_errors_never_contain_the_token() {
    let (_mock, addr) = start_mock().await;
    let wrong = TelegramBotApi::new(&format!("http://{addr}"), "999:wrong-secret-token")
        .checked("api client");
    let error = wrong
        .get_me()
        .await
        .err()
        .checked("wrong token should fail");
    assert!(error.to_string().contains("401"), "{error}");
    assert!(!error.to_string().contains("wrong-secret-token"), "{error}");

    let closed = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .checked("bind");
    let closed_addr = closed.local_addr().checked("addr");
    drop(closed);
    let unreachable = TelegramBotApi::new(&format!("http://{closed_addr}"), "999:other-secret")
        .checked("api client");
    let error = unreachable
        .get_me()
        .await
        .err()
        .checked("unreachable should fail");
    assert!(!error.to_string().contains("other-secret"), "{error}");
    assert!(!format!("{error:?}").contains("other-secret"), "{error:?}");
}

#[tokio::test]
#[ignore = "Requires Docker-backed PostgreSQL"]
async fn bot_serves_start_and_invite_and_notifies_the_admin() {
    let (_container, pool) = create_test_pool().await;
    let (mock, addr) = start_mock().await;
    let api = TelegramBotApi::new(&format!("http://{addr}"), BOT_TOKEN).checked("api client");

    let mut admin = User::new(
        format!("tgadmin_{}", synctv_common::snanoid!(6)).to_lowercase(),
        SignupMethod::AdminCreated,
    );
    admin.role = UserRole::Admin;
    let admin = UserRepository::new(pool.clone())
        .create(&admin)
        .await
        .checked("admin should be created");

    let users = Arc::new(create_test_user_service(pool.clone()));
    let rooms = Arc::new(
        create_test_room_service(pool).with_admission_notifier(Arc::new(
            TelegramAdminNotifier::new(api.clone(), ADMIN_TG_ID),
        )),
    );
    let older = rooms
        .create_room(
            "Older room".to_string(),
            String::new(),
            admin.id,
            None,
            None,
        )
        .await
        .checked("room should be created");
    tokio::time::sleep(Duration::from_millis(20)).await;
    let newer = rooms
        .create_room(
            "Newer room".to_string(),
            String::new(),
            admin.id,
            None,
            None,
        )
        .await
        .checked("room should be created");

    let config = TelegramBotConfig {
        bot_token: BOT_TOKEN.to_string(),
        api_base_url: format!("http://{addr}"),
        admin_user_id: ADMIN_TG_ID,
        admin_username: admin.username.clone(),
        web_app_url: Some(WEB_APP_URL.to_string()),
    };
    let cancel = CancellationToken::new();
    let poller = tokio::spawn(run_polling(
        api.clone(),
        config,
        rooms.clone(),
        users.clone(),
        cancel.clone(),
    ));

    // Startup: menu button points at the Mini App.
    let menu = mock.wait_for("setChatMenuButton", |_| true).await;
    assert_eq!(menu["menu_button"]["type"], "web_app");
    assert_eq!(menu["menu_button"]["web_app"]["url"], WEB_APP_URL);

    // /start -> greeting with a web_app button; a deep-link payload adds a startapp link.
    mock.push_update(message(GUEST_TG_ID, "/start inviteTok_1"))
        .await;
    let reply = mock
        .wait_for("sendMessage", |b| b["chat_id"] == GUEST_TG_ID)
        .await;
    let keyboard = &reply["reply_markup"]["inline_keyboard"];
    assert_eq!(keyboard[0][0]["web_app"]["url"], WEB_APP_URL);
    assert_eq!(
        keyboard[1][0]["url"],
        format!("https://t.me/{BOT_USERNAME}?startapp=inviteTok_1")
    );

    // /invite from someone else is refused.
    mock.push_update(message(GUEST_TG_ID, "/invite")).await;
    mock.wait_for("sendMessage", |b| {
        b["chat_id"] == GUEST_TG_ID && text_of(b).contains("only the server administrator")
    })
    .await;

    // /invite from the admin lists their rooms, newest first, by room id only.
    mock.push_update(message(ADMIN_TG_ID, "/invite")).await;
    let list = mock
        .wait_for("sendMessage", |b| b["chat_id"] == ADMIN_TG_ID)
        .await;
    let rows = list["reply_markup"]["inline_keyboard"]
        .as_array()
        .checked("keyboard rows")
        .clone();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0][0]["text"], "Newer room");
    assert_eq!(rows[0][0]["callback_data"], format!("inv:{}", newer.id));
    assert_eq!(rows[1][0]["callback_data"], format!("inv:{}", older.id));

    // Forged data and other people's presses are answered and change nothing.
    mock.push_update(callback(ADMIN_TG_ID, "cb-bad", "inv:abc"))
        .await;
    let bad = mock
        .wait_for("answerCallbackQuery", |b| {
            b["callback_query_id"] == "cb-bad"
        })
        .await;
    assert!(bad["text"]
        .as_str()
        .unwrap_or_default()
        .contains("no longer valid"));
    let older_data = format!("inv:{}", older.id);
    mock.push_update(callback(GUEST_TG_ID, "cb-guest", &older_data))
        .await;
    mock.wait_for("answerCallbackQuery", |b| {
        b["callback_query_id"] == "cb-guest"
    })
    .await;
    assert!(rooms
        .list_room_invites(older.id, admin.id)
        .await
        .checked("list invites")
        .is_empty());

    // The admin's press creates a 24 h single-use invite and replies with its link.
    mock.push_update(callback(ADMIN_TG_ID, "cb-ok", &older_data))
        .await;
    mock.wait_for("answerCallbackQuery", |b| b["callback_query_id"] == "cb-ok")
        .await;
    let prefix = format!("https://t.me/{BOT_USERNAME}?startapp=");
    let link_msg = mock
        .wait_for("sendMessage", |b| {
            b["chat_id"] == ADMIN_TG_ID && text_of(b).contains(&prefix)
        })
        .await;
    let text = text_of(&link_msg);
    assert!(text.contains("Older room"), "{text}");
    let token: String = text
        .split(&prefix)
        .nth(1)
        .checked("link in reply")
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    assert_eq!(token.len(), 43);
    let invite = rooms
        .find_room_invite(&token)
        .await
        .checked("lookup")
        .checked("invite should exist");
    assert_eq!(invite.room_id, older.id);
    assert_eq!(invite.created_by, admin.id);
    assert_eq!(invite.max_uses, Some(1));
    let ttl = invite.expires_at.checked("expiry") - chrono::Utc::now();
    assert!(
        (ttl - chrono::Duration::hours(24)).num_seconds().abs() < 300,
        "{ttl}"
    );
    for (method, body) in mock.calls.lock().await.iter() {
        if method == "sendMessage" && body["chat_id"] == ADMIN_TG_ID {
            continue;
        }
        assert!(
            !body.to_string().contains(&token),
            "token leaked via {method}"
        );
    }

    // Redeeming the invite notifies the admin.
    let guest = users
        .find_or_create_telegram_user(&TelegramInitData {
            user_id: GUEST_TG_ID,
            first_name: "Olena".to_string(),
            last_name: None,
            username: None,
            start_param: None,
            auth_date: 0,
        })
        .await
        .checked("guest");
    assert!(rooms
        .admit_invited_member(&invite, guest.id, "Olena".to_string())
        .await
        .checked("guest should be admitted"));
    let joined = mock
        .wait_for("sendMessage", |b| {
            b["chat_id"] == ADMIN_TG_ID && text_of(b).contains("Olena joined")
        })
        .await;
    assert!(text_of(&joined).contains("Older room"));

    // Pairing a TV notifies the admin too.
    let pairing = rooms.start_tv_pairing().await.checked("start pairing");
    rooms
        .claim_tv_pairing_with_control(&pairing.code, newer.id, admin.id, None, None)
        .await
        .checked("claim pairing");
    let paired = mock
        .wait_for("sendMessage", |b| {
            b["chat_id"] == ADMIN_TG_ID && text_of(b).contains("A TV was paired")
        })
        .await;
    assert!(text_of(&paired).contains("Newer room"));
    assert!(text_of(&paired).contains(&admin.username));

    cancel.cancel();
    tokio::time::timeout(Duration::from_secs(10), poller)
        .await
        .checked("poller should stop on cancel")
        .checked("poller task");
}
