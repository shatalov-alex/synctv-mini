//! Room invite link routes: creator-managed under `/api/rooms/{roomId}/invites`, redeemed
//! publicly from the Telegram Mini App at `/api/invites/redeem`.

use axum::{
    extract::{Path, Request, State},
    Json,
};
use synctv_api_common::impls::EndpointRateLimitCategory;
use synctv_proto::client::{
    CreateRoomInviteRequest, CreateRoomInviteResponse, ListRoomInvitesResponse,
    RedeemRoomInviteRequest, RedeemRoomInviteResponse, RevokeRoomInvitesRequest,
    RevokeRoomInvitesResponse, RoomPathRequest,
};

use crate::http::{middleware::RequestMetadata, AppResult, AppState};

/// Create an invite link (room creator only). The token is returned once.
#[cfg_attr(
    feature = "openapi",
    utoipa::path(
        post,
        path = "/api/rooms/{roomId}/invites",
        tag = "Room Member",
        params(("roomId" = String, Path, description = "Room ID")),
        request_body = CreateRoomInviteRequest,
        responses(
            (status = 200, description = "Invite created", body = CreateRoomInviteResponse),
            (status = 403, description = "Not the room creator", body = crate::openapi::GoogleRpcStatusSchema)
        ),
        security(("bearer_auth" = []))
    )
)]
pub async fn create_room_invite(
    request_meta: RequestMetadata,
    State(state): State<AppState>,
    Path(path): Path<RoomPathRequest>,
    Json(req): Json<CreateRoomInviteRequest>,
) -> AppResult<Json<CreateRoomInviteResponse>> {
    let client_api = state.shared_api_runtime.client_api.clone();
    let resp = state
        .shared_api_runtime
        .client_api
        .execute_user_endpoint(
            &request_meta.0,
            EndpointRateLimitCategory::Write,
            move |authenticated| async move {
                client_api
                    .create_room_invite(&authenticated.user_id(), &path.room_id, req)
                    .await
            },
        )
        .await
        .map_err(crate::http::error::map_api_error)?;
    Ok(Json(resp))
}

/// List the room's invite links (room creator only).
#[cfg_attr(
    feature = "openapi",
    utoipa::path(
        get,
        path = "/api/rooms/{roomId}/invites",
        tag = "Room Member",
        params(("roomId" = String, Path, description = "Room ID")),
        responses(
            (status = 200, description = "Invites", body = ListRoomInvitesResponse),
            (status = 403, description = "Not the room creator", body = crate::openapi::GoogleRpcStatusSchema)
        ),
        security(("bearer_auth" = []))
    )
)]
pub async fn list_room_invites(
    request_meta: RequestMetadata,
    State(state): State<AppState>,
    Path(path): Path<RoomPathRequest>,
) -> AppResult<Json<ListRoomInvitesResponse>> {
    let client_api = state.shared_api_runtime.client_api.clone();
    let resp = state
        .shared_api_runtime
        .client_api
        .execute_user_endpoint(
            &request_meta.0,
            EndpointRateLimitCategory::Read,
            move |authenticated| async move {
                client_api
                    .list_room_invites(&authenticated.user_id(), &path.room_id)
                    .await
            },
        )
        .await
        .map_err(crate::http::error::map_api_error)?;
    Ok(Json(resp))
}

/// Revoke one invite link, or all of them (`invite_id` = 0). Joined members stay.
#[cfg_attr(
    feature = "openapi",
    utoipa::path(
        post,
        path = "/api/rooms/{roomId}/invites/revoke",
        tag = "Room Member",
        params(("roomId" = String, Path, description = "Room ID")),
        request_body = RevokeRoomInvitesRequest,
        responses(
            (status = 200, description = "Invites revoked", body = RevokeRoomInvitesResponse),
            (status = 403, description = "Not the room creator", body = crate::openapi::GoogleRpcStatusSchema)
        ),
        security(("bearer_auth" = []))
    )
)]
pub async fn revoke_room_invites(
    request_meta: RequestMetadata,
    State(state): State<AppState>,
    Path(path): Path<RoomPathRequest>,
    Json(req): Json<RevokeRoomInvitesRequest>,
) -> AppResult<Json<RevokeRoomInvitesResponse>> {
    let client_api = state.shared_api_runtime.client_api.clone();
    let resp = state
        .shared_api_runtime
        .client_api
        .execute_user_endpoint(
            &request_meta.0,
            EndpointRateLimitCategory::Write,
            move |authenticated| async move {
                client_api
                    .revoke_room_invites(&authenticated.user_id(), &path.room_id, req)
                    .await
            },
        )
        .await
        .map_err(crate::http::error::map_api_error)?;
    Ok(Json(resp))
}

/// Redeem an invite from the Telegram Mini App and sign in.
#[cfg_attr(
    feature = "openapi",
    utoipa::path(
        post,
        path = "/api/invites/redeem",
        tag = "Auth",
        request_body = RedeemRoomInviteRequest,
        responses(
            (status = 200, description = "Joined and signed in", body = RedeemRoomInviteResponse),
            (status = 401, description = "Invalid Telegram data or invite", body = crate::openapi::GoogleRpcStatusSchema),
            (status = 403, description = "Invite expired, used up or revoked", body = crate::openapi::GoogleRpcStatusSchema),
            (status = 404, description = "Telegram login is not enabled", body = crate::openapi::GoogleRpcStatusSchema),
            (status = 429, description = "Rate limited", body = crate::openapi::GoogleRpcStatusSchema)
        )
    )
)]
pub async fn redeem_room_invite(
    State(state): State<AppState>,
    request: Request,
) -> AppResult<Json<RedeemRoomInviteResponse>> {
    let (request_meta, request) = super::auth::extract_auth_request(&state, request).await?;
    let client_ip = request_meta.client_ip;
    let executor = state.shared_api_runtime.client_api.clone();
    let client_api = state.shared_api_runtime.client_api.clone();
    let response = executor
        .execute_public_endpoint_with_control(
            &request_meta,
            EndpointRateLimitCategory::Auth,
            move |request_control| async move {
                let req = super::auth::parse_auth_json::<RedeemRoomInviteRequest>(request).await?;
                client_api
                    .redeem_room_invite_with_control(req, client_ip, Some(&request_control))
                    .await
            },
        )
        .await
        .map_err(crate::http::error::map_api_error)?;
    Ok(Json(response))
}
