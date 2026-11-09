use synctv_core::{
    models::RoomPermission,
    service::{PlaybackStatePatch, PlaybackStateUpdateRequest},
};

use crate::playback_fanout::PlaybackFanoutActor;

use super::{
    playback_gate::{DeviceReport, GateAction, RoomView},
    StreamMessageHandler,
};

impl StreamMessageHandler {
    pub async fn handle_playback_source_update(
        &self,
        update: &synctv_proto::client::UpdatePlaybackRequest,
    ) -> Result<(), String> {
        crate::impls::validate_proto_request(update).map_err(|error| error.to_string())?;
        self.check_realtime_permission(RoomPermission::CONTROL_PLAYBACK_STATE)
            .await
            .map_err(|e| e.to_string())?;
        if self.principal.is_guest() {
            return Err("Guests cannot control playback".to_string());
        }
        let user_id = self.require_user_id()?;
        let target = crate::impls::client::build_start_playback_request(
            synctv_proto::client::StartPlaybackRequest {
                media_id: update.media_id.clone(),
                playlist_id: update.playlist_id.clone(),
                target: update.target.clone(),
                client_operation_id: update.client_operation_id.clone(),
                playing: None,
            },
            &self.public_id_codec,
        )
        .map_err(|error| error.to_string())?;
        let previous_state = self
            .room_service
            .playback_service()
            .get_state(&self.room_id)
            .await
            .map_err(|error| {
                format!(
                    "Failed to load previous playback state for provider lifecycle transition: {error}"
                )
            })?;
        let prepared_fanout = self.playback_fanout.prepare_state_changed_outbox_fanout(
            PlaybackFanoutActor::new(user_id, &self.username)
                .with_client_operation_id(update.client_operation_id.as_deref()),
        );
        let state = if target.media_id.is_none() && target.playlist_id.is_none() {
            self.room_service
                .playback_service()
                .reset_with_outbox(
                    self.room_id,
                    user_id,
                    Some(prepared_fanout.outbox_factory_with_source_changed(true)),
                )
                .await
                .map_err(|e| e.to_string())?
        } else {
            self.room_service
                .playback_service()
                .switch_with_outbox(
                    self.room_id,
                    user_id,
                    target.media_id,
                    target.playlist_id,
                    target.target,
                    target.playing,
                    Some(prepared_fanout.outbox_factory_with_source_changed(true)),
                )
                .await
                .map_err(|e| e.to_string())?
        };
        prepared_fanout.publish_after_outbox_commit();
        self.playback_service
            .handle_provider_lifecycle_transition(Some(&previous_state), &state)
            .await;
        Ok(())
    }

    pub async fn handle_playback_state_update(
        &self,
        update: &synctv_proto::client::UpdatePlaybackStateRequest,
    ) -> Result<(), String> {
        self.check_realtime_permission(RoomPermission::CONTROL_PLAYBACK_STATE)
            .await
            .map_err(|e| e.to_string())?;
        if self.principal.is_guest() {
            return Err("Guests cannot control playback".to_string());
        }
        let user_id = self.require_user_id()?;
        let update_parts = crate::impls::client::build_playback_state_update(
            update.clone(),
            &self.public_id_codec,
        )
        .map_err(|error| error.to_string())?;
        let previous_state = self
            .room_service
            .playback_service()
            .get_state(&self.room_id)
            .await
            .map_err(|error| {
                format!(
                    "Failed to load previous playback state for provider lifecycle transition: {error}"
                )
            })?;

        let playing = update_parts.playing;
        let position = update_parts.position;
        let speed = update_parts.speed;
        let version = update_parts.version;
        let expected_source = update_parts.expected_source;
        let client_operation_id = update_parts.client_operation_id;
        let client_time_millis = update_parts.client_time_millis;
        let playback_service = self.room_service.playback_service();
        let prepared_fanout = self.playback_fanout.prepare_state_changed_outbox_fanout(
            PlaybackFanoutActor::new(user_id, &self.username)
                .with_client_operation_id(client_operation_id.as_deref()),
        );
        let mut request = PlaybackStateUpdateRequest::new(
            self.room_id,
            user_id,
            PlaybackStatePatch::new(playing, position, speed),
        )
        .with_expected_version(version)
        .with_client_time_millis(client_time_millis)
        .with_outbox(Some(prepared_fanout.outbox_factory()));
        if let Some(expected_source) = expected_source {
            request = request.with_expected_source(expected_source);
        }
        let state = playback_service
            .update_playback_state(request)
            .await
            .map_err(|error| error.to_string())?;
        prepared_fanout.publish_after_outbox_commit();
        self.playback_service
            .handle_provider_lifecycle_transition(Some(&previous_state), &state)
            .await;

        Ok(())
    }

    pub async fn handle_player_status(
        &self,
        report: &synctv_proto::client::PlayerStatusReport,
    ) -> Result<(), String> {
        crate::impls::validate_proto_request(report).map_err(|error| error.to_string())?;
        // Only those who may pause the room themselves can hold it; everyone else's player
        // is still reported, but never holds anyone back.
        let may_hold = !self.principal.is_guest()
            && self
                .check_realtime_permission(RoomPermission::CONTROL_PLAYBACK_STATE)
                .await
                .is_ok();
        self.playback_gate.report(
            &self.room_id,
            self.connection_id.as_str(),
            DeviceReport {
                media_id: report.media_id.clone(),
                participating: report.participating && may_hold,
                ready: report.ready,
                position: report.position,
                state_version: report.state_version,
            },
            std::time::Instant::now(),
        );
        let (waiting_devices, holding) = self.evaluate_playback_gate().await;
        self.sender.send(synctv_proto::client::ServerMessage {
            message: Some(synctv_proto::client::server_message::Message::PlaybackGate(
                synctv_proto::client::PlaybackGateStatus {
                    waiting_devices,
                    holding,
                },
            )),
        })
    }

    pub(super) async fn leave_playback_gate(&self) {
        self.playback_gate
            .remove(&self.room_id, self.connection_id.as_str());
        self.evaluate_playback_gate().await;
    }

    /// Lets the gate pause or resume the room. Failures are only logged: the next report retries.
    async fn evaluate_playback_gate(&self) -> (u32, bool) {
        let state = match self
            .room_service
            .playback_service()
            .get_state(&self.room_id)
            .await
        {
            Ok(state) => state,
            Err(error) => {
                tracing::warn!(error = %error, "Playback gate could not load the room state");
                return (0, false);
            }
        };
        let media_id = state
            .playing_media_id
            .and_then(|id| self.public_id_codec.encode_media_id(id).ok())
            .unwrap_or_default();
        let view = RoomView {
            media_id: &media_id,
            playing: state.is_playing,
            position: state.computed_position_at(self.clock.now()),
            version: state.version,
        };
        let decision = self
            .playback_gate
            .decide(&self.room_id, &view, std::time::Instant::now());
        if let Some(action) = decision.action {
            let new_version = self.apply_playback_gate_action(action, &state).await;
            self.playback_gate
                .finish_action(&self.room_id, action, new_version);
        }
        (decision.waiting_devices, decision.holding)
    }

    async fn apply_playback_gate_action(
        &self,
        action: GateAction,
        previous_state: &synctv_core::models::RoomPlaybackState,
    ) -> Option<i64> {
        // Reporting needs no playback permission; only the room's own hold and resume happen here.
        let user_id = self.principal.user_id()?;
        let (playing, position) = match action {
            GateAction::Hold { position } => (false, position),
            GateAction::Resume { position } => (true, position),
        };
        let prepared_fanout = self
            .playback_fanout
            .prepare_state_changed_outbox_fanout(PlaybackFanoutActor::new(user_id, &self.username));
        let request = PlaybackStateUpdateRequest::new(
            self.room_id,
            user_id,
            PlaybackStatePatch::new(Some(playing), Some(position), None),
        )
        .with_expected_version(Some(previous_state.version))
        .with_outbox(Some(prepared_fanout.outbox_factory()));
        match self
            .room_service
            .playback_service()
            .update_playback_state(request)
            .await
        {
            Ok(state) => {
                prepared_fanout.publish_after_outbox_commit();
                self.playback_service
                    .handle_provider_lifecycle_transition(Some(previous_state), &state)
                    .await;
                Some(state.version)
            }
            Err(error) => {
                tracing::debug!(error = %error, "Playback gate update did not apply");
                None
            }
        }
    }
}
