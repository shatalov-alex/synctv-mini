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

fn test_pool(state: &super::AppState) -> TestResult<sqlx::PgPool> {
    state
        .test_database_leases()
        .lock()
        .map_err(|error| anyhow::anyhow!("lease lock poisoned: {error}"))?
        .first()
        .map(|lease| lease.pool.clone())
        .ok_or_else(|| anyhow::anyhow!("test database lease missing"))
}

impl ServiceApiHarness {
    pub(crate) fn pool(&self) -> TestResult<sqlx::PgPool> {
        test_pool(&self.state)
    }
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
    let pool = test_pool(&state)?;
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

#[tokio::test]
#[ignore = "Requires Docker-backed PostgreSQL"]
async fn direct_url_media_without_proxy_mode_gets_the_server_default() -> TestResult {
    let mut settings = runtime_settings(ServiceApiActAs::TelegramAdmin, TELEGRAM_ADMIN_ID)?;
    settings.media.direct_url_default_proxy_mode = synctv_core::models::PlaybackProxyMode::Only;
    let harness = Box::pin(setup(settings)).await?;
    let app = &harness.app;
    let (_, room) = send(
        app,
        Call::keyed("POST", "/api/rooms").json(serde_json::json!({ "name": "Proxy room" })),
    )
    .await?;
    let room_id = str_field(&room, "/id")?.to_string();

    let add = |proxy_mode: Option<i32>| {
        let mut direct_url = serde_json::json!({
            "medias": [{ "url": "https://media.example.com/clip.mp4" }]
        });
        if let Some(proxy_mode) = proxy_mode {
            direct_url["proxyMode"] = serde_json::json!(proxy_mode);
        }
        Call::keyed("POST", format!("/api/rooms/{room_id}/media"))
            .json(serde_json::json!({ "sourceConfig": { "directUrl": direct_url } }))
    };

    // Unset and explicit AUTO both take the server default (PLAYBACK_PROXY_MODE_ONLY = 2).
    for proxy_mode in [None, Some(0)] {
        let (status, media) = send(app, add(proxy_mode)).await?;
        assert_eq!(status, StatusCode::OK, "{media}");
        assert_eq!(
            media.pointer("/sourceConfig/directUrl/proxyMode"),
            Some(&serde_json::json!(2)),
            "{media}"
        );
    }
    // An explicit mode from the client is kept (PLAYBACK_PROXY_MODE_DIRECT_ONLY = 4).
    let (status, media) = send(app, add(Some(4))).await?;
    assert_eq!(status, StatusCode::OK, "{media}");
    assert_eq!(
        media.pointer("/sourceConfig/directUrl/proxyMode"),
        Some(&serde_json::json!(4)),
        "{media}"
    );
    Ok(())
}

#[tokio::test]
#[ignore = "Requires PostgreSQL and Redis"]
async fn replacing_an_expired_link_keeps_the_viewing_and_applies_the_proxy_default() -> TestResult {
    let mut settings = runtime_settings(ServiceApiActAs::TelegramAdmin, TELEGRAM_ADMIN_ID)?;
    settings.media.direct_url_default_proxy_mode = synctv_core::models::PlaybackProxyMode::Only;
    let harness = Box::pin(setup(settings)).await?;
    let app = &harness.app;
    let room_id = create_room(app, "Link refresh room").await?;
    let media_id = add_direct_url(app, &room_id, "movie", None).await?;
    let other_id = add_direct_url(app, &room_id, "other", None).await?;

    let media_url = format!("/api/rooms/{room_id}/media/{media_id}");
    let playback_url = format!("/api/rooms/{room_id}/playback");
    let (status, state) = send(
        app,
        Call::keyed("POST", format!("{playback_url}/start"))
            .json(serde_json::json!({ "mediaId": media_id })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "start: {state}");
    assert_eq!(
        report_duration(app, &room_id, &media_id, 5400.0).await?["stored"],
        true
    );
    let (status, state) = send(
        app,
        Call::keyed("PATCH", &playback_url).json(serde_json::json!({
            "type": 2, "playing": false, "position": 1234.0
        })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "seek: {state}");

    let replace = |url: &str, proxy_mode: Option<i32>| {
        let mut direct_url = serde_json::json!({ "medias": [{ "url": url }] });
        if let Some(proxy_mode) = proxy_mode {
            direct_url["proxyMode"] = serde_json::json!(proxy_mode);
        }
        Call::keyed("PATCH", &media_url)
            .json(serde_json::json!({ "sourceConfig": { "directUrl": direct_url } }))
    };

    // 1. The media was stored direct-only; a new link with no mode must not silently drop it...
    let (status, media) = send(app, replace("https://media.example.com/new-1.mp4", None)).await?;
    assert_eq!(status, StatusCode::OK, "{media}");
    assert_eq!(
        media.pointer("/sourceConfig/directUrl/proxyMode"),
        Some(&serde_json::json!(4)),
        "{media}"
    );
    // 2. ...and the length of the film is still known.
    assert_eq!(
        media.pointer("/sourceConfig/directUrl/durationSeconds"),
        Some(&serde_json::json!(5400.0)),
        "{media}"
    );
    // 3. The room stays on the same media at the same position, paused.
    let (_, playback) = send(app, Call::keyed("GET", &playback_url)).await?;
    assert_eq!(
        str_field(&playback, "/playbackState/playingMediaId")?,
        media_id,
        "{playback}"
    );
    assert_eq!(
        playback.pointer("/playbackState/position"),
        Some(&serde_json::json!(1234.0)),
        "{playback}"
    );
    assert_eq!(
        playback.pointer("/playbackState/isPlaying"),
        None,
        "{playback}"
    );
    assert_eq!(
        playback.pointer("/playback/durationSeconds"),
        Some(&serde_json::json!(5400.0)),
        "{playback}"
    );

    // 4. An explicit length and mode replace the kept ones.
    let (status, media) = send(
        app,
        Call::keyed("PATCH", &media_url).json(serde_json::json!({ "sourceConfig": { "directUrl": {
            "medias": [{ "url": "https://media.example.com/new-1b.mp4" }],
            "proxyMode": 1,
            "durationSeconds": 6000.0
        } } })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{media}");
    assert_eq!(
        media.pointer("/sourceConfig/directUrl/proxyMode"),
        Some(&serde_json::json!(1)),
        "{media}"
    );
    let (_, playback) = send(app, Call::keyed("GET", &playback_url)).await?;
    assert_eq!(
        playback.pointer("/playback/durationSeconds"),
        Some(&serde_json::json!(6000.0)),
        "{playback}"
    );

    // 5. Watched earlier, then re-linked while the room is elsewhere: the saved spot survives.
    let (status, _) = send(
        app,
        Call::keyed("POST", format!("{playback_url}/start"))
            .json(serde_json::json!({ "mediaId": other_id })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(app, replace("https://media.example.com/new-2.mp4", Some(2))).await?;
    assert_eq!(status, StatusCode::OK);
    let (status, history) =
        send(app, Call::keyed("GET", format!("{playback_url}/history"))).await?;
    assert_eq!(status, StatusCode::OK, "{history}");
    let entries = history
        .pointer("/entries")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("no entries: {history}"))?;
    let entry = entries
        .iter()
        .find(|entry| {
            entry
                .pointer("/mediaId")
                .and_then(serde_json::Value::as_str)
                == Some(media_id.as_str())
        })
        .ok_or_else(|| anyhow::anyhow!("movie not in history: {history}"))?;
    assert_eq!(
        entry.pointer("/positionSeconds"),
        Some(&serde_json::json!(1234.0)),
        "{entry}"
    );
    let (status, state) = send(
        app,
        Call::keyed(
            "POST",
            format!("{playback_url}/history/{}/play", str_field(entry, "/id")?),
        )
        .json(serde_json::json!({})),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{state}");
    let (_, playback) = send(app, Call::keyed("GET", &playback_url)).await?;
    assert_eq!(
        str_field(&playback, "/playbackState/playingMediaId")?,
        media_id,
        "{playback}"
    );
    let resumed = playback
        .pointer("/playbackState/position")
        .and_then(serde_json::Value::as_f64)
        .ok_or_else(|| anyhow::anyhow!("no position: {playback}"))?;
    assert!((1234.0..1236.0).contains(&resumed), "{playback}");
    Ok(())
}

pub(crate) async fn create_room(app: &axum::Router, name: &str) -> TestResult<String> {
    let (status, room) = send(
        app,
        Call::keyed("POST", "/api/rooms").json(serde_json::json!({ "name": name })),
    )
    .await?;
    anyhow::ensure!(status == StatusCode::OK, "create room: {room}");
    Ok(str_field(&room, "/id")?.to_string())
}

pub(crate) async fn add_direct_url(
    app: &axum::Router,
    room_id: &str,
    name: &str,
    duration_seconds: Option<f64>,
) -> TestResult<String> {
    let mut direct_url = serde_json::json!({
        "medias": [{ "url": format!("https://media.example.com/{name}.mp4") }],
        "proxyMode": 4
    });
    if let Some(duration_seconds) = duration_seconds {
        direct_url["durationSeconds"] = serde_json::json!(duration_seconds);
    }
    let (status, media) = send(
        app,
        Call::keyed("POST", format!("/api/rooms/{room_id}/media")).json(serde_json::json!({
            "name": name,
            "sourceConfig": { "directUrl": direct_url }
        })),
    )
    .await?;
    anyhow::ensure!(status == StatusCode::OK, "add media: {media}");
    Ok(str_field(&media, "/id")?.to_string())
}

async fn report_duration(
    app: &axum::Router,
    room_id: &str,
    media_id: &str,
    duration_seconds: f64,
) -> TestResult<serde_json::Value> {
    let (status, body) = send(
        app,
        Call::keyed(
            "PUT",
            format!("/api/rooms/{room_id}/media/{media_id}/duration"),
        )
        .json(serde_json::json!({ "durationSeconds": duration_seconds })),
    )
    .await?;
    anyhow::ensure!(status == StatusCode::OK, "report duration: {body}");
    Ok(body)
}

#[tokio::test]
#[ignore = "Requires Docker-backed PostgreSQL"]
async fn reported_duration_is_kept_once_and_served_by_playback() -> TestResult {
    let harness = Box::pin(setup(runtime_settings(
        ServiceApiActAs::TelegramAdmin,
        TELEGRAM_ADMIN_ID,
    )?))
    .await?;
    let app = &harness.app;
    let room_id = create_room(app, "Duration room").await?;
    let media_id = add_direct_url(app, &room_id, "movie", None).await?;

    // Selected before anyone knows its length: playback has no duration yet.
    let (status, state) = send(
        app,
        Call::keyed("POST", format!("/api/rooms/{room_id}/playback/start"))
            .json(serde_json::json!({ "mediaId": media_id })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "start playback: {state}");
    let (_, playback) = send(
        app,
        Call::keyed("GET", format!("/api/rooms/{room_id}/playback")),
    )
    .await?;
    assert_eq!(
        playback.pointer("/playback/durationSeconds"),
        None,
        "{playback}"
    );

    let first = report_duration(app, &room_id, &media_id, 1234.5).await?;
    assert_eq!(
        first,
        serde_json::json!({ "stored": true, "durationSeconds": 1234.5 })
    );
    // Idempotent: a later, different report does not replace it (pbjson omits stored=false).
    let second = report_duration(app, &room_id, &media_id, 99.0).await?;
    assert_eq!(second, serde_json::json!({ "durationSeconds": 1234.5 }));

    let (_, playback) = send(
        app,
        Call::keyed("GET", format!("/api/rooms/{room_id}/playback")),
    )
    .await?;
    assert_eq!(
        playback.pointer("/playback/durationSeconds"),
        Some(&serde_json::json!(1234.5)),
        "{playback}"
    );

    // The per-source metadata row written at selection time is filled too (auto-advance).
    let internal_room_id = harness
        .state
        .shared_api_runtime
        .public_id_codec
        .decode_room_id(&room_id)
        .map_err(anyhow::Error::msg)?;
    let internal_media_id = harness
        .state
        .shared_api_runtime
        .public_id_codec
        .decode_media_id(&media_id)
        .map_err(anyhow::Error::msg)?;
    let pool = harness.pool()?;
    let metadata = synctv_core::repository::PlaybackSourceMetadataRepository::new(pool)
        .get(&synctv_core::models::PlaybackSourceIdentity::static_media(
            internal_room_id,
            internal_media_id,
        ))
        .await
        .map_err(|error| anyhow::anyhow!(error.to_string()))?
        .ok_or_else(|| anyhow::anyhow!("metadata row missing"))?;
    assert_eq!(metadata.duration_seconds, Some(1234.5));
    Ok(())
}

#[tokio::test]
#[ignore = "Requires Docker-backed PostgreSQL"]
async fn implausible_or_redundant_durations_are_ignored() -> TestResult {
    let harness = Box::pin(setup(runtime_settings(
        ServiceApiActAs::TelegramAdmin,
        TELEGRAM_ADMIN_ID,
    )?))
    .await?;
    let app = &harness.app;
    let room_id = create_room(app, "Bogus durations").await?;
    let media_id = add_direct_url(app, &room_id, "clip", None).await?;
    for bogus in [0.0, -5.0, 48.0 * 3600.0 + 1.0] {
        let body = report_duration(app, &room_id, &media_id, bogus).await?;
        assert_eq!(body, serde_json::json!({}), "{bogus}");
    }

    // A duration the adder supplied stays authoritative.
    let known = add_direct_url(app, &room_id, "known", Some(60.0)).await?;
    let body = report_duration(app, &room_id, &known, 75.0).await?;
    assert_eq!(body, serde_json::json!({ "durationSeconds": 60.0 }));

    // Someone outside the room may not report.
    let stranger = create_user(
        &harness.pool()?,
        "stranger",
        synctv_core::models::UserRole::User,
    )
    .await?;
    let token = harness
        .state
        .jwt_service
        .sign_access_token(&stranger.id, 0)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let mut call = Call::keyed(
        "PUT",
        format!("/api/rooms/{room_id}/media/{media_id}/duration"),
    )
    .json(serde_json::json!({ "durationSeconds": 10.0 }));
    call.authorization = Some(format!("Bearer {token}"));
    let (status, body) = send(app, call).await?;
    assert!(
        status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND,
        "{status}: {body}"
    );
    Ok(())
}

async fn update_playback(
    app: &axum::Router,
    room_id: &str,
    body: serde_json::Value,
) -> TestResult<serde_json::Value> {
    let (status, state) = send(
        app,
        Call::keyed("PATCH", format!("/api/rooms/{room_id}/playback")).json(body),
    )
    .await?;
    anyhow::ensure!(status == StatusCode::OK, "update playback: {state}");
    Ok(state)
}

fn f64_field(value: &serde_json::Value, pointer: &str) -> TestResult<f64> {
    value
        .pointer(pointer)
        .and_then(serde_json::Value::as_f64)
        .ok_or_else(|| anyhow::anyhow!("missing {pointer} in {value}"))
}

#[tokio::test]
#[ignore = "Requires Docker-backed PostgreSQL"]
async fn timeline_lists_playing_rooms_with_server_computed_positions() -> TestResult {
    let harness = Box::pin(setup(runtime_settings(
        ServiceApiActAs::TelegramAdmin,
        TELEGRAM_ADMIN_ID,
    )?))
    .await?;
    let app = &harness.app;
    let playing_room = create_room(app, "Playing room").await?;
    let idle_room = create_room(app, "Idle room").await?;
    let media_id = add_direct_url(app, &playing_room, "film", Some(600.0)).await?;
    let (status, started) = send(
        app,
        Call::keyed("POST", format!("/api/rooms/{playing_room}/playback/start"))
            .json(serde_json::json!({ "mediaId": media_id })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{started}");
    update_playback(
        app,
        &playing_room,
        serde_json::json!({ "type": 1, "playing": true, "position": 100.0 }),
    )
    .await?;

    // A viewer is connected to the idle room; a third room has neither viewers nor playback.
    let quiet_room = create_room(app, "Quiet room").await?;
    let codec = &harness.state.shared_api_runtime.public_id_codec;
    let presence = &harness.state.presence_service;
    presence
        .register_connection(
            "conn-1".to_string(),
            "node-1".to_string(),
            synctv_core::models::RealtimeActor::User {
                user_id: harness.admin.id,
                public_id: codec
                    .encode_user_id(harness.admin.id)
                    .map_err(anyhow::Error::msg)?,
            },
        )
        .await
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    presence
        .join_room(
            "conn-1",
            codec
                .decode_room_id(&idle_room)
                .map_err(anyhow::Error::msg)?,
        )
        .await
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;

    let (status, timeline) = send(app, Call::keyed("GET", "/api/service/timeline")).await?;
    assert_eq!(status, StatusCode::OK, "{timeline}");
    let rooms = timeline
        .pointer("/rooms")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("rooms missing: {timeline}"))?;
    let listed: Vec<&str> = rooms
        .iter()
        .filter_map(|room| room["roomId"].as_str())
        .collect();
    assert_eq!(listed.len(), 2, "{timeline}");
    assert!(listed.contains(&playing_room.as_str()) && listed.contains(&idle_room.as_str()));
    assert!(!listed.contains(&quiet_room.as_str()));
    let watched = rooms
        .iter()
        .find(|room| room["roomId"] == idle_room.as_str())
        .ok_or_else(|| anyhow::anyhow!("idle room missing"))?;
    assert_eq!(watched["onlineViewers"], 1);
    assert_eq!(watched["mediaId"], serde_json::Value::Null);
    let entry = rooms
        .iter()
        .find(|room| room["roomId"] == playing_room.as_str())
        .ok_or_else(|| anyhow::anyhow!("playing room missing"))?;
    assert_eq!(str_field(entry, "/roomId")?, playing_room);
    assert_eq!(str_field(entry, "/roomName")?, "Playing room");
    assert_eq!(str_field(entry, "/mediaId")?, media_id);
    assert_eq!(str_field(entry, "/mediaName")?, "film");
    assert_eq!(entry["playing"], true);
    assert_eq!(entry["live"], false);
    assert_eq!(entry["onlineViewers"], 0);
    assert_eq!(f64_field(entry, "/durationSeconds")?, 600.0);
    assert_eq!(str_field(entry, "/duration")?, "0:10:00");
    let first = f64_field(entry, "/positionSeconds")?;
    assert!((100.0..102.0).contains(&first), "{entry}");
    assert!((f64_field(entry, "/remainingSeconds")? - (600.0 - first)).abs() < 1e-6);
    assert!(entry["serverTimeMillis"].as_i64().is_some(), "{entry}");

    // Advances on the server clock while playing...
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
    let (_, one) = send(
        app,
        Call::keyed("GET", format!("/api/service/rooms/{playing_room}/timeline")),
    )
    .await?;
    let later = f64_field(&one, "/positionSeconds")?;
    assert!(later >= first + 1.0, "{first} -> {later}");

    // ...and stays put while paused.
    update_playback(
        app,
        &playing_room,
        serde_json::json!({ "type": 2, "playing": false, "position": 300.0 }),
    )
    .await?;
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    let (_, paused) = send(
        app,
        Call::keyed("GET", format!("/api/service/rooms/{playing_room}/timeline")),
    )
    .await?;
    assert_eq!(paused["playing"], false);
    assert_eq!(f64_field(&paused, "/positionSeconds")?, 300.0);
    assert_eq!(str_field(&paused, "/position")?, "0:05:00");

    // A room with nothing selected has null media fields.
    let (status, idle) = send(
        app,
        Call::keyed("GET", format!("/api/service/rooms/{idle_room}/timeline")),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{idle}");
    assert_eq!(idle["mediaId"], serde_json::Value::Null);
    assert_eq!(idle["mediaName"], serde_json::Value::Null);
    assert_eq!(idle["durationSeconds"], serde_json::Value::Null);
    assert_eq!(idle["positionSeconds"], serde_json::Value::Null);
    Ok(())
}

#[tokio::test]
#[ignore = "Requires Docker-backed PostgreSQL"]
async fn timeline_is_for_the_service_key_and_admins_only() -> TestResult {
    let harness = Box::pin(setup(runtime_settings(
        ServiceApiActAs::TelegramAdmin,
        TELEGRAM_ADMIN_ID,
    )?))
    .await?;
    let user = create_user(
        &harness.pool()?,
        "plain_viewer",
        synctv_core::models::UserRole::User,
    )
    .await?;
    for (account, expected) in [
        (&harness.admin, StatusCode::OK),
        (&user, StatusCode::FORBIDDEN),
    ] {
        let token = harness
            .state
            .jwt_service
            .sign_access_token(&account.id, 0)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let mut call = Call::keyed("GET", "/api/service/timeline");
        call.authorization = Some(format!("Bearer {token}"));
        let (status, body) = send(&harness.app, call).await?;
        assert_eq!(status, expected, "{}: {body}", account.username);
    }

    // The key is enough even when it acts as a non-admin account.
    let plain = Box::pin(setup(runtime_settings(
        ServiceApiActAs::Username("svc_admin".to_string()),
        0,
    )?))
    .await?;
    let (status, body) = send(&plain.app, Call::keyed("GET", "/api/service/timeline")).await?;
    assert_eq!(status, StatusCode::OK, "{body}");

    let mut anonymous = Call::keyed("GET", "/api/service/timeline");
    anonymous.authorization = None;
    let (status, _) = send(&harness.app, anonymous).await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    Ok(())
}

#[tokio::test]
#[ignore = "Requires Docker-backed PostgreSQL"]
async fn rooms_can_be_renamed_by_their_managers() -> TestResult {
    let harness = Box::pin(setup(runtime_settings(
        ServiceApiActAs::TelegramAdmin,
        TELEGRAM_ADMIN_ID,
    )?))
    .await?;
    let app = &harness.app;
    let room_id = create_room(app, "Old name").await?;
    let (status, room) = send(
        app,
        Call::keyed("PATCH", format!("/api/rooms/{room_id}/name"))
            .json(serde_json::json!({ "name": "Movie night" })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{room}");
    assert_eq!(str_field(&room, "/name")?, "Movie night");
    let (_, fetched) = send(app, Call::keyed("GET", format!("/api/rooms/{room_id}"))).await?;
    assert!(fetched.to_string().contains("Movie night"), "{fetched}");

    let (status, body) = send(
        app,
        Call::keyed("PATCH", format!("/api/rooms/{room_id}/name"))
            .json(serde_json::json!({ "name": "<b>x</b>" })),
    )
    .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    let stranger = create_user(
        &harness.pool()?,
        "rename_stranger",
        synctv_core::models::UserRole::User,
    )
    .await?;
    let token = harness
        .state
        .jwt_service
        .sign_access_token(&stranger.id, 0)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let mut call = Call::keyed("PATCH", format!("/api/rooms/{room_id}/name"))
        .json(serde_json::json!({ "name": "Hijacked" }));
    call.authorization = Some(format!("Bearer {token}"));
    let (status, body) = send(app, call).await?;
    assert!(
        status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND,
        "{status}: {body}"
    );
    Ok(())
}

/// The request sequence `docs/service-api.md` shows, end to end with the key. Run with
/// `--nocapture` to see the responses the doc's examples are based on.
#[tokio::test]
#[ignore = "Requires Docker-backed PostgreSQL"]
async fn documented_service_api_flow_works() -> TestResult {
    let harness = Box::pin(setup(runtime_settings(
        ServiceApiActAs::TelegramAdmin,
        TELEGRAM_ADMIN_ID,
    )?))
    .await?;
    let app = &harness.app;
    let step = |label: &str, status: StatusCode, body: &serde_json::Value| {
        println!("== {label}: {status}\n{body:#}");
        status
    };

    let (status, room) = send(
        app,
        Call::keyed("POST", "/api/rooms").json(serde_json::json!({ "name": "Movie night" })),
    )
    .await?;
    assert_eq!(step("create room", status, &room), StatusCode::OK);
    let room_id = str_field(&room, "/id")?.to_string();

    let (status, body) = send(
        app,
        Call::keyed("PATCH", format!("/api/rooms/{room_id}/name"))
            .json(serde_json::json!({ "name": "Friday movie night" })),
    )
    .await?;
    assert_eq!(step("rename", status, &body), StatusCode::OK);

    let mut media_ids = Vec::new();
    for (name, url) in [
        ("Part 1", "https://cdn.example.com/part1.mp4"),
        ("Part 2", "https://cdn.example.com/part2.mp4"),
    ] {
        let (status, media) = send(
            app,
            Call::keyed("POST", format!("/api/rooms/{room_id}/media")).json(serde_json::json!({
                "name": name,
                "sourceConfig": { "directUrl": { "medias": [{ "url": url }], "proxyMode": 2 } }
            })),
        )
        .await?;
        assert_eq!(step("add media", status, &media), StatusCode::OK);
        media_ids.push(str_field(&media, "/id")?.to_string());
    }

    let (status, list) = send(
        app,
        Call::keyed("POST", format!("/api/rooms/{room_id}/media/list"))
            .json(serde_json::json!({ "pageSize": 100 })),
    )
    .await?;
    assert_eq!(step("list", status, &list), StatusCode::OK);

    // Reorder: put Part 2 before Part 1.
    let (status, moved) = send(
        app,
        Call::keyed("POST", format!("/api/rooms/{room_id}/media/move")).json(serde_json::json!({
            "mediaIds": [media_ids[1]],
            "beforeMediaId": media_ids[0]
        })),
    )
    .await?;
    assert_eq!(step("move", status, &moved), StatusCode::OK);
    let (_, list) = send(
        app,
        Call::keyed("POST", format!("/api/rooms/{room_id}/media/list"))
            .json(serde_json::json!({ "pageSize": 100 })),
    )
    .await?;
    assert_eq!(str_field(&list, "/media/0/id")?, media_ids[1], "{list}");

    let (status, started) = send(
        app,
        Call::keyed("POST", format!("/api/rooms/{room_id}/playback/start"))
            .json(serde_json::json!({ "mediaId": media_ids[1] })),
    )
    .await?;
    assert_eq!(step("start", status, &started), StatusCode::OK);
    let (status, next) = send(
        app,
        Call::keyed("POST", format!("/api/rooms/{room_id}/playback/next"))
            .json(serde_json::json!({})),
    )
    .await?;
    assert_eq!(step("next", status, &next), StatusCode::OK);
    let (status, timeline) = send(
        app,
        Call::keyed("GET", format!("/api/service/rooms/{room_id}/timeline")),
    )
    .await?;
    assert_eq!(step("room timeline", status, &timeline), StatusCode::OK);
    assert_eq!(
        str_field(&timeline, "/mediaId")?,
        media_ids[0],
        "next went to Part 1"
    );

    let (status, body) = send(
        app,
        Call::keyed(
            "DELETE",
            format!("/api/rooms/{room_id}/media/{}", media_ids[1]),
        ),
    )
    .await?;
    assert_eq!(step("delete media", status, &body), StatusCode::OK);
    let (status, body) = send(app, Call::keyed("DELETE", format!("/api/rooms/{room_id}"))).await?;
    assert_eq!(step("delete room", status, &body), StatusCode::OK);
    Ok(())
}
