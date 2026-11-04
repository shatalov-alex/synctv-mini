//! Service routes for the app holding the service API key (admins may read them too):
//! the current timeline of active rooms.

use axum::{
    extract::{Path, State},
    Json,
};
use synctv_api_common::impls::client::timeline::{RoomTimeline, TimelineResponse};
use synctv_api_common::impls::EndpointRateLimitCategory;
use synctv_proto::client::RoomPathRequest;

use crate::http::{middleware::RequestMetadata, AppResult, AppState};

/// `GET /api/service/timeline`: rooms with an online viewer or a running playback.
pub async fn get_service_timeline(
    request_meta: RequestMetadata,
    State(state): State<AppState>,
) -> AppResult<Json<TimelineResponse>> {
    let client_api = state.shared_api_runtime.client_api.clone();
    let resp = state
        .shared_api_runtime
        .client_api
        .execute_user_endpoint(
            &request_meta.0,
            EndpointRateLimitCategory::Read,
            move |authenticated| async move { client_api.service_timeline(&authenticated).await },
        )
        .await
        .map_err(crate::http::error::map_api_error)?;
    Ok(Json(resp))
}

/// `GET /api/service/rooms/{roomId}/timeline`: one room, active or not.
pub async fn get_service_room_timeline(
    request_meta: RequestMetadata,
    State(state): State<AppState>,
    Path(path): Path<RoomPathRequest>,
) -> AppResult<Json<RoomTimeline>> {
    let client_api = state.shared_api_runtime.client_api.clone();
    let resp = state
        .shared_api_runtime
        .client_api
        .execute_user_endpoint(
            &request_meta.0,
            EndpointRateLimitCategory::Read,
            move |authenticated| async move {
                client_api
                    .service_room_timeline(&authenticated, &path.room_id)
                    .await
            },
        )
        .await
        .map_err(crate::http::error::map_api_error)?;
    Ok(Json(resp))
}
