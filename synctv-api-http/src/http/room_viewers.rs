//! Who is in a room, by the names people know them by (`/api/rooms/{roomId}/viewers`), and
//! keeping the caller's own Telegram name current (`/api/user/telegram-profile`).

use axum::{
    extract::{Path, State},
    Json,
};
use synctv_api_common::impls::EndpointRateLimitCategory;
use synctv_proto::client::{
    ListRoomViewersResponse, RefreshTelegramProfileRequest, RefreshTelegramProfileResponse,
    RoomPathRequest,
};

use crate::http::{middleware::RequestMetadata, AppResult, AppState};

/// List the room's people and TVs.
#[cfg_attr(
    feature = "openapi",
    utoipa::path(
        get,
        path = "/api/rooms/{roomId}/viewers",
        tag = "Room Member",
        params(("roomId" = String, Path, description = "Room ID")),
        responses(
            (status = 200, description = "Viewers", body = ListRoomViewersResponse),
            (status = 403, description = "Not one of the people in the room", body = crate::openapi::GoogleRpcStatusSchema)
        ),
        security(("bearer_auth" = []))
    )
)]
pub async fn list_room_viewers(
    request_meta: RequestMetadata,
    State(state): State<AppState>,
    Path(path): Path<RoomPathRequest>,
) -> AppResult<Json<ListRoomViewersResponse>> {
    let client_api = state.shared_api_runtime.client_api.clone();
    let resp = state
        .shared_api_runtime
        .client_api
        .execute_user_endpoint(
            &request_meta.0,
            EndpointRateLimitCategory::Read,
            move |authenticated| async move {
                client_api
                    .list_room_viewers(&authenticated.user_id(), &path.room_id)
                    .await
            },
        )
        .await
        .map_err(crate::http::error::map_api_error)?;
    Ok(Json(resp))
}

/// Refresh the caller's stored Telegram name from their Mini App launch.
#[cfg_attr(
    feature = "openapi",
    utoipa::path(
        post,
        path = "/api/user/telegram-profile",
        tag = "User",
        request_body = RefreshTelegramProfileRequest,
        responses(
            (status = 200, description = "Done", body = RefreshTelegramProfileResponse),
            (status = 401, description = "Launch data not valid", body = crate::openapi::GoogleRpcStatusSchema)
        ),
        security(("bearer_auth" = []))
    )
)]
pub async fn refresh_telegram_profile(
    request_meta: RequestMetadata,
    State(state): State<AppState>,
    Json(req): Json<RefreshTelegramProfileRequest>,
) -> AppResult<Json<RefreshTelegramProfileResponse>> {
    let client_ip = request_meta.0.client_ip;
    let client_api = state.shared_api_runtime.client_api.clone();
    let resp = state
        .shared_api_runtime
        .client_api
        .execute_user_endpoint(
            &request_meta.0,
            EndpointRateLimitCategory::Auth,
            move |authenticated| async move {
                client_api
                    .refresh_telegram_profile_with_control(
                        &authenticated.user_id(),
                        req,
                        client_ip,
                        None,
                    )
                    .await
            },
        )
        .await
        .map_err(crate::http::error::map_api_error)?;
    Ok(Json(resp))
}
