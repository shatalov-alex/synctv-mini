//! Service timeline (`/api/service/timeline`): where each active room's current video is,
//! computed on the server clock at request time. For the service API key and admins.

use serde::Serialize;
use synctv_core::models::{
    MediaSourceConfig, PlaybackKind, PlaybackSourceMetadata, RoomId, RoomPlaybackState,
};
use synctv_core::service::AuthenticatedToken;

use super::ClientApiImpl;
use crate::impls::ApiError;

/// Upper bound on rooms listed; a single server never has this many active at once.
const MAX_TIMELINE_ROOMS: usize = 500;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomTimeline {
    pub room_id: String,
    pub room_name: String,
    /// `None` when nothing is selected (or a dynamic-playlist item without a static media).
    pub media_id: Option<String>,
    pub media_name: Option<String>,
    pub playing: bool,
    pub speed: f64,
    /// `None` when nothing is selected; clamped to the duration when it is known.
    pub position_seconds: Option<f64>,
    pub duration_seconds: Option<f64>,
    pub remaining_seconds: Option<f64>,
    /// `position_seconds` as `H:MM:SS`.
    pub position: Option<String>,
    /// `duration_seconds` as `H:MM:SS`.
    pub duration: Option<String>,
    pub online_viewers: usize,
    pub live: bool,
    pub server_time_millis: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineResponse {
    pub rooms: Vec<RoomTimeline>,
    pub server_time_millis: i64,
}

/// What the timeline knows about the selected source besides the playback state.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TimelineSource {
    pub media_id: Option<String>,
    pub media_name: Option<String>,
    pub duration_seconds: Option<f64>,
    pub live: bool,
}

/// `H:MM:SS`, rounded down to whole seconds.
#[must_use]
pub fn format_timecode(seconds: f64) -> String {
    let total = if seconds.is_finite() && seconds > 0.0 {
        // Truncation is the point: a timecode shows completed seconds.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let whole = seconds.floor() as u64;
        whole
    } else {
        0
    };
    format!(
        "{}:{:02}:{:02}",
        total / 3600,
        (total / 60) % 60,
        total % 60
    )
}

/// Build one room's entry at `now`. Live sources have no meaningful position or end.
#[must_use]
pub fn room_timeline(
    room_id: String,
    room_name: String,
    state: &RoomPlaybackState,
    source: Option<TimelineSource>,
    online_viewers: usize,
    now: chrono::DateTime<chrono::Utc>,
) -> RoomTimeline {
    let server_time_millis = now.timestamp_millis();
    let Some(source) = source else {
        return RoomTimeline {
            room_id,
            room_name,
            media_id: None,
            media_name: None,
            playing: state.is_playing,
            speed: state.speed,
            position_seconds: None,
            duration_seconds: None,
            remaining_seconds: None,
            position: None,
            duration: None,
            online_viewers,
            live: false,
            server_time_millis,
        };
    };
    let duration_seconds = source
        .duration_seconds
        .filter(|duration| !source.live && duration.is_finite() && *duration > 0.0);
    let mut position_seconds = state.computed_position_at(now).max(0.0);
    if let Some(duration) = duration_seconds {
        position_seconds = position_seconds.min(duration);
    }
    let remaining_seconds = duration_seconds.map(|duration| (duration - position_seconds).max(0.0));
    RoomTimeline {
        room_id,
        room_name,
        media_id: source.media_id,
        media_name: source.media_name,
        playing: state.is_playing,
        speed: state.speed,
        position_seconds: Some(position_seconds),
        duration_seconds,
        remaining_seconds,
        position: Some(format_timecode(position_seconds)),
        duration: duration_seconds.map(format_timecode),
        online_viewers,
        live: source.live,
        server_time_millis,
    }
}

impl ClientApiImpl {
    /// The service API key and global admins may read every room's timeline.
    async fn ensure_timeline_reader(
        &self,
        authenticated: &AuthenticatedToken,
    ) -> Result<(), ApiError> {
        if authenticated.service_api_key {
            return Ok(());
        }
        let user = self
            .user_service
            .get_user(&authenticated.user_id())
            .await
            .map_err(ApiError::from)?;
        if user.is_admin_or_above() {
            Ok(())
        } else {
            Err(ApiError::Authorization(
                "The timeline is available to the service API key and administrators".to_string(),
            ))
        }
    }

    /// `GET /api/service/timeline`: rooms with an online viewer or a running playback.
    pub async fn service_timeline(
        &self,
        authenticated: &AuthenticatedToken,
    ) -> Result<TimelineResponse, ApiError> {
        self.ensure_timeline_reader(authenticated).await?;
        let mut room_ids: Vec<RoomId> = self
            .presence_service
            .hot_room_stats()
            .await
            .map_err(ApiError::from)?
            .into_iter()
            .map(|stats| stats.room_id)
            .collect();
        let limit = i64::try_from(MAX_TIMELINE_ROOMS).unwrap_or(i64::MAX);
        for room_id in self
            .room_service
            .playback_service()
            .list_playing_room_ids(limit)
            .await
            .map_err(ApiError::from)?
        {
            if !room_ids.contains(&room_id) {
                room_ids.push(room_id);
            }
        }
        room_ids.truncate(MAX_TIMELINE_ROOMS);

        let mut rooms = Vec::with_capacity(room_ids.len());
        for room_id in room_ids {
            match self.room_timeline_entry(room_id).await {
                Ok(entry) => rooms.push(entry),
                // Deleted between listing and reading: not active any more.
                Err(ApiError::NotFound(_)) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(TimelineResponse {
            rooms,
            server_time_millis: self.clock.now().timestamp_millis(),
        })
    }

    /// `GET /api/service/rooms/{roomId}/timeline`.
    pub async fn service_room_timeline(
        &self,
        authenticated: &AuthenticatedToken,
        room_id: &str,
    ) -> Result<RoomTimeline, ApiError> {
        self.ensure_timeline_reader(authenticated).await?;
        let room_id = self.parse_room_id(room_id)?;
        self.room_timeline_entry(room_id).await
    }

    async fn room_timeline_entry(&self, room_id: RoomId) -> Result<RoomTimeline, ApiError> {
        let room = self
            .room_service
            .get_room(&room_id)
            .await
            .map_err(ApiError::from)?;
        let state = self
            .room_service
            .get_playback_state(&room_id)
            .await
            .map_err(ApiError::from)?;
        let source = self.timeline_source(&state).await?;
        let stats = self
            .presence_service
            .room_stats(room_id)
            .await
            .map_err(ApiError::from)?;
        let public_room_id = self
            .public_id_codec
            .encode_room_id(room_id)
            .map_err(ApiError::Internal)?;
        Ok(room_timeline(
            public_room_id,
            room.name,
            &state,
            source,
            stats.online_member_count + stats.online_guest_count,
            self.clock.now(),
        ))
    }

    /// Name, duration and liveness of the selected source: the per-source metadata row
    /// written when it was selected, falling back to the media itself.
    async fn timeline_source(
        &self,
        state: &RoomPlaybackState,
    ) -> Result<Option<TimelineSource>, ApiError> {
        if state.playing_media_id.is_none() && state.playing_playlist_id.is_none() {
            return Ok(None);
        }
        let metadata: Option<PlaybackSourceMetadata> = self
            .room_service
            .playback_service()
            .source_metadata_for_state(state)
            .await
            .map_err(ApiError::from)?;
        let mut source = TimelineSource {
            media_name: metadata
                .as_ref()
                .and_then(|metadata| metadata.media_name.clone()),
            duration_seconds: metadata
                .as_ref()
                .and_then(|metadata| metadata.duration_seconds),
            live: metadata
                .as_ref()
                .is_some_and(|metadata| metadata.playback_kind == PlaybackKind::Live),
            media_id: None,
        };
        if let Some(media_id) = state.playing_media_id {
            source.media_id = Some(
                self.public_id_codec
                    .encode_media_id(media_id)
                    .map_err(ApiError::Internal)?,
            );
            if let Some(media) = self
                .room_service
                .media_service()
                .get_room_media(&state.room_id, &media_id)
                .await
                .map_err(ApiError::from)?
            {
                source.media_name = Some(media.name.clone());
                if let MediaSourceConfig::DirectUrl(config) = &media.source_config {
                    source.live |= config.playback_kind == Some(PlaybackKind::Live);
                    if source.duration_seconds.is_none() {
                        source.duration_seconds = config.positive_duration_seconds();
                    }
                }
            }
        }
        Ok(Some(source))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone, Utc};
    use synctv_core::models::{MediaId, RoomPlaybackState};

    fn state(
        playing: bool,
        position: f64,
        speed: f64,
        anchor: chrono::DateTime<Utc>,
    ) -> RoomPlaybackState {
        let mut state = RoomPlaybackState::new(RoomId::new());
        state.playing_media_id = Some(MediaId::new());
        state.is_playing = playing;
        state.position = position;
        state.speed = speed;
        state.updated_at = anchor;
        state
    }

    fn source(duration_seconds: Option<f64>) -> Option<TimelineSource> {
        Some(TimelineSource {
            media_id: Some("med_1".to_string()),
            media_name: Some("Film".to_string()),
            duration_seconds,
            live: false,
        })
    }

    fn anchor() -> chrono::DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 4, 20, 0, 0)
            .single()
            .expect("valid time")
    }

    fn at(state: &RoomPlaybackState, duration: Option<f64>, after_secs: i64) -> RoomTimeline {
        room_timeline(
            "room_1".to_string(),
            "Room".to_string(),
            state,
            source(duration),
            2,
            anchor() + Duration::seconds(after_secs),
        )
    }

    #[test]
    fn timecodes() {
        assert_eq!(format_timecode(0.0), "0:00:00");
        assert_eq!(format_timecode(59.9), "0:00:59");
        assert_eq!(format_timecode(3725.4), "1:02:05");
        assert_eq!(format_timecode(36_000.0), "10:00:00");
        assert_eq!(format_timecode(f64::NAN), "0:00:00");
    }

    #[test]
    fn position_advances_with_speed_while_playing() {
        let playing = state(true, 100.0, 1.5, anchor());
        let entry = at(&playing, Some(1000.0), 10);
        assert_eq!(entry.position_seconds, Some(115.0));
        assert_eq!(entry.remaining_seconds, Some(885.0));
        assert_eq!(entry.position.as_deref(), Some("0:01:55"));
        assert_eq!(entry.duration.as_deref(), Some("0:16:40"));
        assert_eq!(
            entry.server_time_millis,
            (anchor() + Duration::seconds(10)).timestamp_millis()
        );
        assert!(entry.playing);
    }

    #[test]
    fn position_is_frozen_while_paused() {
        let paused = state(false, 100.0, 1.0, anchor());
        assert_eq!(at(&paused, Some(1000.0), 0).position_seconds, Some(100.0));
        assert_eq!(at(&paused, Some(1000.0), 600).position_seconds, Some(100.0));
    }

    #[test]
    fn position_is_clamped_at_the_end() {
        let playing = state(true, 990.0, 1.0, anchor());
        let entry = at(&playing, Some(1000.0), 60);
        assert_eq!(entry.position_seconds, Some(1000.0));
        assert_eq!(entry.remaining_seconds, Some(0.0));
    }

    #[test]
    fn unknown_duration_leaves_end_fields_empty() {
        let playing = state(true, 30.0, 1.0, anchor());
        let entry = at(&playing, None, 5);
        assert_eq!(entry.position_seconds, Some(35.0));
        assert_eq!(entry.duration_seconds, None);
        assert_eq!(entry.remaining_seconds, None);
        assert_eq!(entry.duration, None);
    }

    #[test]
    fn nothing_selected_has_null_media_fields() {
        let mut idle = RoomPlaybackState::new(RoomId::new());
        idle.updated_at = anchor();
        let entry = room_timeline(
            "room_1".to_string(),
            "Room".to_string(),
            &idle,
            None,
            0,
            anchor(),
        );
        let json = serde_json::to_value(&entry).expect("serializes");
        for field in [
            "mediaId",
            "mediaName",
            "positionSeconds",
            "durationSeconds",
            "remainingSeconds",
            "position",
            "duration",
        ] {
            assert_eq!(json[field], serde_json::Value::Null, "{field}");
        }
        assert_eq!(json["onlineViewers"], 0);
        assert_eq!(json["live"], false);
    }

    #[test]
    fn live_sources_report_no_duration() {
        let playing = state(true, 30.0, 1.0, anchor());
        let entry = room_timeline(
            "room_1".to_string(),
            "Room".to_string(),
            &playing,
            Some(TimelineSource {
                live: true,
                duration_seconds: Some(100.0),
                ..TimelineSource::default()
            }),
            1,
            anchor(),
        );
        assert!(entry.live);
        assert_eq!(entry.duration_seconds, None);
    }
}
