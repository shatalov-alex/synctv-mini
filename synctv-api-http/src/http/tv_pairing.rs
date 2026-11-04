//! TV pairing routes: the TV starts and polls a pairing publicly (`/api/tv/pairings`,
//! `/api/tv/pairings/poll`), a signed-in room member claims its code
//! (`/api/tv/pairings/claim`), and the room creator lists and unpairs TVs
//! (`/api/rooms/{roomId}/tvs`).

use axum::{
    extract::{Path, Request, State},
    Json,
};
use synctv_api_common::impls::EndpointRateLimitCategory;
use synctv_proto::client::{
    ClaimTvPairingRequest, ClaimTvPairingResponse, ListTvDevicesResponse, PollTvPairingRequest,
    PollTvPairingResponse, RevokeTvDeviceResponse, RoomMemberTargetPathRequest, RoomPathRequest,
    StartTvPairingRequest, StartTvPairingResponse,
};

use crate::http::{middleware::RequestMetadata, AppResult, AppState};

/// Start a TV pairing. Returns the code to show and the secret to poll with.
#[cfg_attr(
    feature = "openapi",
    utoipa::path(
        post,
        path = "/api/tv/pairings",
        tag = "Auth",
        request_body = StartTvPairingRequest,
        responses(
            (status = 200, description = "Pairing started", body = StartTvPairingResponse),
            (status = 429, description = "Rate limited", body = crate::openapi::GoogleRpcStatusSchema)
        )
    )
)]
pub async fn start_tv_pairing(
    State(state): State<AppState>,
    request: Request,
) -> AppResult<Json<StartTvPairingResponse>> {
    let (request_meta, request) = super::auth::extract_auth_request(&state, request).await?;
    let executor = state.shared_api_runtime.client_api.clone();
    let client_api = state.shared_api_runtime.client_api.clone();
    let response = executor
        .execute_public_endpoint(
            &request_meta,
            EndpointRateLimitCategory::Auth,
            move || async move {
                let req = super::auth::parse_auth_json::<StartTvPairingRequest>(request).await?;
                client_api.start_tv_pairing(req).await
            },
        )
        .await
        .map_err(crate::http::error::map_api_error)?;
    Ok(Json(response))
}

/// Poll a TV pairing with its secret. Tokens are returned once, with status `CLAIMED`.
#[cfg_attr(
    feature = "openapi",
    utoipa::path(
        post,
        path = "/api/tv/pairings/poll",
        tag = "Auth",
        request_body = PollTvPairingRequest,
        responses(
            (status = 200, description = "Pairing status", body = PollTvPairingResponse),
            (status = 429, description = "Rate limited", body = crate::openapi::GoogleRpcStatusSchema)
        )
    )
)]
pub async fn poll_tv_pairing(
    State(state): State<AppState>,
    request: Request,
) -> AppResult<Json<PollTvPairingResponse>> {
    let (request_meta, request) = super::auth::extract_auth_request(&state, request).await?;
    let client_ip = request_meta.client_ip;
    let executor = state.shared_api_runtime.client_api.clone();
    let client_api = state.shared_api_runtime.client_api.clone();
    let response = executor
        .execute_public_endpoint_with_control(
            &request_meta,
            // Polled every couple of seconds; the secret is 256-bit, so no auth-tier budget.
            EndpointRateLimitCategory::Read,
            move |request_control| async move {
                let req = super::auth::parse_auth_json::<PollTvPairingRequest>(request).await?;
                client_api
                    .poll_tv_pairing_with_control(req, client_ip, Some(&request_control))
                    .await
            },
        )
        .await
        .map_err(crate::http::error::map_api_error)?;
    Ok(Json(response))
}

/// Claim a TV pairing code for a room (room creator or a member with playback control).
#[cfg_attr(
    feature = "openapi",
    utoipa::path(
        post,
        path = "/api/tv/pairings/claim",
        tag = "Room Member",
        request_body = ClaimTvPairingRequest,
        responses(
            (status = 200, description = "TV paired", body = ClaimTvPairingResponse),
            (status = 401, description = "Too many failed attempts", body = crate::openapi::GoogleRpcStatusSchema),
            (status = 403, description = "No playback control in the room", body = crate::openapi::GoogleRpcStatusSchema),
            (status = 404, description = "Unknown or expired code", body = crate::openapi::GoogleRpcStatusSchema),
            (status = 429, description = "Rate limited", body = crate::openapi::GoogleRpcStatusSchema)
        ),
        security(("bearer_auth" = []))
    )
)]
pub async fn claim_tv_pairing(
    request_meta: RequestMetadata,
    State(state): State<AppState>,
    Json(req): Json<ClaimTvPairingRequest>,
) -> AppResult<Json<ClaimTvPairingResponse>> {
    let client_ip = request_meta.0.client_ip;
    let client_api = state.shared_api_runtime.client_api.clone();
    let resp = state
        .shared_api_runtime
        .client_api
        .execute_user_endpoint_with_control(
            &request_meta.0,
            EndpointRateLimitCategory::Write,
            move |request_control, authenticated| async move {
                client_api
                    .claim_tv_pairing_with_control(
                        &authenticated.user_id(),
                        req,
                        client_ip,
                        Some(&request_control),
                    )
                    .await
            },
        )
        .await
        .map_err(crate::http::error::map_api_error)?;
    Ok(Json(resp))
}

/// List the TVs paired to the room (room members, except the TVs themselves).
#[cfg_attr(
    feature = "openapi",
    utoipa::path(
        get,
        path = "/api/rooms/{roomId}/tvs",
        tag = "Room Member",
        params(("roomId" = String, Path, description = "Room ID")),
        responses(
            (status = 200, description = "Paired TVs", body = ListTvDevicesResponse),
            (status = 403, description = "Not a member of the room, or a TV", body = crate::openapi::GoogleRpcStatusSchema)
        ),
        security(("bearer_auth" = []))
    )
)]
pub async fn list_tv_devices(
    request_meta: RequestMetadata,
    State(state): State<AppState>,
    Path(path): Path<RoomPathRequest>,
) -> AppResult<Json<ListTvDevicesResponse>> {
    let client_api = state.shared_api_runtime.client_api.clone();
    let resp = state
        .shared_api_runtime
        .client_api
        .execute_user_endpoint(
            &request_meta.0,
            EndpointRateLimitCategory::Read,
            move |authenticated| async move {
                client_api
                    .list_tv_devices(&authenticated.user_id(), &path.room_id)
                    .await
            },
        )
        .await
        .map_err(crate::http::error::map_api_error)?;
    Ok(Json(resp))
}

/// Unpair a TV (room creator only): its tokens stop refreshing and it leaves the room.
#[cfg_attr(
    feature = "openapi",
    utoipa::path(
        post,
        path = "/api/rooms/{roomId}/tvs/{userId}/revoke",
        tag = "Room Member",
        params(
            ("roomId" = String, Path, description = "Room ID"),
            ("userId" = String, Path, description = "TV user ID")
        ),
        responses(
            (status = 200, description = "TV unpaired", body = RevokeTvDeviceResponse),
            (status = 403, description = "Not the room creator", body = crate::openapi::GoogleRpcStatusSchema),
            (status = 404, description = "No such paired TV", body = crate::openapi::GoogleRpcStatusSchema)
        ),
        security(("bearer_auth" = []))
    )
)]
pub async fn revoke_tv_device(
    request_meta: RequestMetadata,
    State(state): State<AppState>,
    Path(path): Path<RoomMemberTargetPathRequest>,
) -> AppResult<Json<RevokeTvDeviceResponse>> {
    let client_api = state.shared_api_runtime.client_api.clone();
    let resp = state
        .shared_api_runtime
        .client_api
        .execute_user_endpoint(
            &request_meta.0,
            EndpointRateLimitCategory::Write,
            move |authenticated| async move {
                client_api
                    .revoke_tv_device(&authenticated.user_id(), &path.room_id, &path.user_id)
                    .await
            },
        )
        .await
        .map_err(crate::http::error::map_api_error)?;
    Ok(Json(resp))
}
