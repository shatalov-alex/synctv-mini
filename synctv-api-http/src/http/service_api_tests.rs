//! Service API key: keyed requests reach the normal user endpoints as the act-as account,
//! only from the internal network; JWTs keep working.

use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt as _;
use tower::ServiceExt;

use super::tests::test_app_state_with_runtime_settings;
use synctv_api_common::service_api::{ServiceApiActAs, ServiceApiKeyHash, ServiceApiSettings};

type TestResult<T = ()> = anyhow::Result<T>;

pub(crate) const SERVICE_KEY: &str = "stk_5f0c3a8d1e2b4c6a9f7e0d1c2b3a49586f7e6d5c4b3a2918";
pub(crate) const TELEGRAM_ADMIN_ID: i64 = 424_242;
const INTERNAL_PEER: &str = "172.18.0.5:51000";

pub(crate) struct ServiceApiHarness {
    pub(crate) state: super::AppState,
    pub(crate) app: axum::Router,
    pub(crate) admin: synctv_core::models::User,
}

pub(crate) fn runtime_settings(
    act_as: ServiceApiActAs,
    telegram_admin_user_id: i64,
) -> TestResult<synctv_api_common::ApiRuntimeSettings> {
    Ok(synctv_api_common::ApiRuntimeSettings {
        telegram: synctv_api_common::TelegramAuthSettings {
            admin_user_id: telegram_admin_user_id,
            admin_username: "svc_admin".to_string(),
            ..synctv_api_common::TelegramAuthSettings::default()
        },
        service_api: ServiceApiSettings {
            key_hash: Some(ServiceApiKeyHash::from_key(SERVICE_KEY).map_err(anyhow::Error::msg)?),
            act_as,
            ..ServiceApiSettings::default()
        },
        ..synctv_api_common::ApiRuntimeSettings::default()
    })
}

pub(crate) async fn create_user(
    pool: &sqlx::PgPool,
    username: &str,
    role: synctv_core::models::UserRole,
) -> TestResult<synctv_core::models::User> {
    let now = synctv_core::SystemClock.now();
    synctv_core::repository::UserRepository::new(pool.clone())
        .create(&synctv_core::models::User {
            id: synctv_core::models::UserId::new(),
            username: username.to_string(),
            role,
            avatar_file_reference_id: None,
            status: synctv_core::models::UserStatus::Active,
            signup_method: synctv_core::models::SignupMethod::AdminCreated,
            created_at: now,
            updated_at: now,
            version: 0,
            deleted_at: None,
            is_banned: false,
            banned_at: None,
            banned_by: None,
            banned_reason: None,
        })
        .await
        .map_err(|error| anyhow::anyhow!(error.to_string()))
}

pub(crate) async fn setup(
    settings: synctv_api_common::ApiRuntimeSettings,
) -> TestResult<ServiceApiHarness> {
    let state = test_app_state_with_runtime_settings(settings);
    let pool = state
        .test_database_leases()
        .lock()
        .map_err(|error| anyhow::anyhow!("lease lock poisoned: {error}"))?
        .first()
        .map(|lease| lease.pool.clone())
        .ok_or_else(|| anyhow::anyhow!("test database lease missing"))?;
    let admin = create_user(&pool, "svc_admin", synctv_core::models::UserRole::Admin).await?;
    let app = super::create_router_from_shared_state(&state)?;
    Ok(ServiceApiHarness { state, app, admin })
}

pub(crate) struct Call<'a> {
    pub(crate) method: &'a str,
    pub(crate) uri: String,
    pub(crate) authorization: Option<String>,
    pub(crate) peer: &'a str,
    pub(crate) body: Option<serde_json::Value>,
    pub(crate) extra_header: Option<(&'a str, &'a str)>,
}

impl<'a> Call<'a> {
    pub(crate) fn keyed(method: &'a str, uri: impl Into<String>) -> Self {
        Self {
            method,
            uri: uri.into(),
            authorization: Some(format!("Bearer {SERVICE_KEY}")),
            peer: INTERNAL_PEER,
            body: None,
            extra_header: None,
        }
    }

    pub(crate) fn json(mut self, body: serde_json::Value) -> Self {
        self.body = Some(body);
        self
    }
}

pub(crate) async fn send(
    app: &axum::Router,
    call: Call<'_>,
) -> TestResult<(StatusCode, serde_json::Value)> {
    let mut builder = Request::builder().method(call.method).uri(&call.uri);
    if let Some(authorization) = &call.authorization {
        builder = builder.header(header::AUTHORIZATION, authorization);
    }
    if let Some((name, value)) = call.extra_header {
        builder = builder.header(name, value);
    }
    let body = match &call.body {
        Some(body) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(serde_json::to_vec(body)?)
        }
        None => Body::empty(),
    };
    let mut request = builder.body(body)?;
    request
        .extensions_mut()
        .insert(ConnectInfo(call.peer.parse::<SocketAddr>()?));
    let response = app.clone().oneshot(request).await?;
    let status = response.status();
    let bytes = response.into_body().collect().await?.to_bytes();
    let json = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or_else(|_| {
            serde_json::Value::String(String::from_utf8_lossy(&bytes).into_owned())
        })
    };
    Ok((status, json))
}

pub(crate) fn str_field<'v>(value: &'v serde_json::Value, pointer: &str) -> TestResult<&'v str> {
    value
        .pointer(pointer)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("missing {pointer} in {value}"))
}

#[tokio::test]
#[ignore = "Requires Docker-backed PostgreSQL"]
async fn service_key_creates_room_adds_media_and_lists_as_telegram_admin() -> TestResult {
    let harness = Box::pin(setup(runtime_settings(
        ServiceApiActAs::TelegramAdmin,
        TELEGRAM_ADMIN_ID,
    )?))
    .await?;
    let app = &harness.app;

    let (status, room) = send(
        app,
        Call::keyed("POST", "/api/rooms").json(serde_json::json!({ "name": "Service room" })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "create room: {room}");
    let room_id = str_field(&room, "/id")?.to_string();

    let (status, media) = send(
        app,
        Call::keyed("POST", format!("/api/rooms/{room_id}/media")).json(serde_json::json!({
            "name": "Clip",
            "sourceConfig": { "directUrl": {
                "medias": [{ "url": "https://media.example.com/clip.mp4" }],
                "proxyMode": 2
            }}
        })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "add media: {media}");
    let media_id = str_field(&media, "/id")?.to_string();

    let (status, list) = send(
        app,
        Call::keyed("POST", format!("/api/rooms/{room_id}/media/list"))
            .json(serde_json::json!({ "pageSize": 100 })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "list media: {list}");
    assert_eq!(str_field(&list, "/media/0/id")?, media_id);

    // The room belongs to the Telegram admin's account, so the Mini App can manage it.
    let internal_room_id = harness
        .state
        .shared_api_runtime
        .public_id_codec
        .decode_room_id(&room_id)
        .map_err(anyhow::Error::msg)?;
    let stored = harness
        .state
        .room_service
        .get_room(&internal_room_id)
        .await
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    assert_eq!(stored.created_by, harness.admin.id);
    Ok(())
}

#[tokio::test]
#[ignore = "Requires Docker-backed PostgreSQL"]
async fn service_key_rejects_wrong_key_tunnel_and_external_peers() -> TestResult {
    let harness = Box::pin(setup(runtime_settings(
        ServiceApiActAs::TelegramAdmin,
        TELEGRAM_ADMIN_ID,
    )?))
    .await?;
    let app = &harness.app;

    let (status, _) = send(app, Call::keyed("GET", "/api/user")).await?;
    assert_eq!(status, StatusCode::OK, "valid key from the Docker network");

    let mut wrong = Call::keyed("GET", "/api/user");
    wrong.authorization = Some(format!("Bearer stk_{}", "0".repeat(48)));
    let (status, body) = send(app, wrong).await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "wrong key: {body}");

    for header in ["Cf-Ray", "Cf-Connecting-Ip"] {
        let mut tunnel = Call::keyed("GET", "/api/user");
        tunnel.extra_header = Some((header, "1.2.3.4"));
        let (status, body) = send(app, tunnel).await?;
        assert_eq!(status, StatusCode::FORBIDDEN, "{header}: {body}");
    }

    let mut external = Call::keyed("GET", "/api/user");
    external.peer = "203.0.113.9:443";
    let (status, body) = send(app, external).await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "external peer: {body}");

    // A forwarded header naming an internal address does not make an external peer internal.
    let mut spoofed = Call::keyed("GET", "/api/user");
    spoofed.peer = "203.0.113.9:443";
    spoofed.extra_header = Some(("X-Forwarded-For", "172.18.0.5"));
    let (status, _) = send(app, spoofed).await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    Ok(())
}

#[tokio::test]
#[ignore = "Requires Docker-backed PostgreSQL"]
async fn jwt_requests_are_unaffected_by_the_service_key() -> TestResult {
    let harness = Box::pin(setup(runtime_settings(
        ServiceApiActAs::TelegramAdmin,
        TELEGRAM_ADMIN_ID,
    )?))
    .await?;
    let token = harness
        .state
        .jwt_service
        .sign_access_token(&harness.admin.id, 0)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let mut call = Call::keyed("GET", "/api/user");
    call.authorization = Some(format!("Bearer {token}"));
    // JWTs are accepted from anywhere, tunnel included.
    call.peer = "203.0.113.9:443";
    call.extra_header = Some(("Cf-Ray", "abc"));
    let (status, user) = send(&harness.app, call).await?;
    assert_eq!(status, StatusCode::OK, "jwt: {user}");
    assert_eq!(str_field(&user, "/username")?, "svc_admin");
    Ok(())
}

#[tokio::test]
#[ignore = "Requires Docker-backed PostgreSQL"]
async fn service_key_reports_unresolvable_act_as_account() -> TestResult {
    // telegram.admin_user_id unset: there is no Telegram admin to act as.
    let harness = Box::pin(setup(runtime_settings(ServiceApiActAs::TelegramAdmin, 0)?)).await?;
    let (status, body) = send(&harness.app, Call::keyed("GET", "/api/user")).await?;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert!(body.to_string().contains("act_as"), "{body}");

    let harness = Box::pin(setup(runtime_settings(
        ServiceApiActAs::Username("nobody_here".to_string()),
        TELEGRAM_ADMIN_ID,
    )?))
    .await?;
    let (status, _) = send(&harness.app, Call::keyed("GET", "/api/user")).await?;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);

    let harness = Box::pin(setup(runtime_settings(
        ServiceApiActAs::Username("svc_admin".to_string()),
        0,
    )?))
    .await?;
    let (status, user) = send(&harness.app, Call::keyed("GET", "/api/user")).await?;
    assert_eq!(status, StatusCode::OK, "{user}");
    assert_eq!(str_field(&user, "/username")?, "svc_admin");
    Ok(())
}

#[tokio::test]
#[ignore = "Requires Docker-backed PostgreSQL"]
async fn service_key_is_refused_when_not_configured() -> TestResult {
    let harness = Box::pin(setup(synctv_api_common::ApiRuntimeSettings::default())).await?;
    let (status, _) = send(&harness.app, Call::keyed("GET", "/api/user")).await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    Ok(())
}
