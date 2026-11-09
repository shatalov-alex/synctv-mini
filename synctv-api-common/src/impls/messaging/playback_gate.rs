//! Holds a room while a connected device hasn't loaded the video.
//!
//! Players report their status over the room stream. While the room plays and a device can't
//! keep up, the room is paused at the lowest reported position and resumed once everyone is
//! ready. A hold is an ordinary pause and resume, so every client follows it without knowing
//! about this module. The state is per server process and rebuilt from the next reports.

use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use parking_lot::Mutex;
use synctv_core::models::RoomId;

/// A device that stops reporting no longer holds anyone back.
const REPORT_STALE_AFTER: Duration = Duration::from_secs(10);
/// A device that can't load for this long stops holding the room until it reports ready again.
const MAX_WAIT_FOR_DEVICE: Duration = Duration::from_secs(45);
/// During a hold, a change of the room this small is a pause; a bigger one is a seek.
const SEEK_DISTANCE_SECS: f64 = 1.0;
/// A hold rewinds the room by at most this much, so a report cannot drag it far back.
const MAX_HOLD_REWIND_SECS: f64 = 30.0;

#[derive(Debug, Clone, PartialEq)]
pub struct DeviceReport {
    pub media_id: String,
    /// False for devices that don't play the room here: remote mode, background, failed player.
    pub participating: bool,
    pub ready: bool,
    /// Where the player is; only set once it has caught up with the room.
    pub position: Option<f64>,
    pub state_version: i64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RoomView<'a> {
    pub media_id: &'a str,
    pub playing: bool,
    pub position: f64,
    pub version: i64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum GateAction {
    Hold { position: f64 },
    Resume { position: f64 },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GateDecision {
    pub action: Option<GateAction>,
    pub waiting_devices: u32,
    pub holding: bool,
}

#[derive(Debug)]
struct Device {
    report: DeviceReport,
    last_seen: Instant,
    blocking_since: Option<Instant>,
    given_up: bool,
}

/// The room state a hold left. A newer version means someone else changed the room.
#[derive(Debug, Clone, Copy)]
struct Hold {
    version: i64,
    position: f64,
}

#[derive(Debug, Default)]
struct RoomGate {
    devices: HashMap<String, Device>,
    hold: Option<Hold>,
    applying: bool,
}

impl RoomGate {
    fn refresh_devices(&mut self, view: &RoomView<'_>, now: Instant) -> u32 {
        self.devices
            .retain(|_, device| now.duration_since(device.last_seen) < REPORT_STALE_AFTER);
        let counting = view.playing || self.hold.is_some();
        let mut waiting = 0;
        for device in self.devices.values_mut() {
            let blocking = device.report.participating
                && (device.report.media_id != view.media_id || !device.report.ready);
            if !blocking || !counting {
                device.blocking_since = None;
                device.given_up = false;
            }
            if !blocking {
                continue;
            }
            if counting {
                let since = *device.blocking_since.get_or_insert(now);
                device.given_up = now.duration_since(since) >= MAX_WAIT_FOR_DEVICE;
            }
            if !device.given_up {
                waiting += 1;
            }
        }
        waiting
    }

    fn lowest_position(&self, view: &RoomView<'_>) -> f64 {
        self.devices
            .values()
            .filter(|device| {
                device.report.participating
                    && !device.given_up
                    && device.report.media_id == view.media_id
                    && device.report.state_version == view.version
            })
            .filter_map(|device| device.report.position)
            .filter(|position| position.is_finite() && *position >= 0.0)
            .fold(view.position, f64::min)
            .max(view.position - MAX_HOLD_REWIND_SECS)
    }
}

#[derive(Debug, Default)]
pub struct PlaybackGate {
    rooms: Mutex<HashMap<RoomId, RoomGate>>,
}

impl PlaybackGate {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn report(
        &self,
        room_id: &RoomId,
        connection_id: &str,
        report: DeviceReport,
        now: Instant,
    ) {
        let mut rooms = self.rooms.lock();
        let room = rooms.entry(*room_id).or_default();
        let device = room
            .devices
            .entry(connection_id.to_string())
            .or_insert_with(|| Device {
                report: report.clone(),
                last_seen: now,
                blocking_since: None,
                given_up: false,
            });
        device.report = report;
        device.last_seen = now;
    }

    pub fn remove(&self, room_id: &RoomId, connection_id: &str) {
        let mut rooms = self.rooms.lock();
        if let Some(room) = rooms.get_mut(room_id) {
            room.devices.remove(connection_id);
            if room.devices.is_empty() {
                rooms.remove(room_id);
            }
        }
    }

    /// What the room should do now. An action must be followed by [`Self::finish_action`].
    pub fn decide(&self, room_id: &RoomId, view: &RoomView<'_>, now: Instant) -> GateDecision {
        let mut rooms = self.rooms.lock();
        let Some(room) = rooms.get_mut(room_id) else {
            return GateDecision {
                action: None,
                waiting_devices: 0,
                holding: false,
            };
        };
        if view.media_id.is_empty() {
            room.hold = None;
        }
        let waiting = room.refresh_devices(view, now);
        if let Some(hold) = room
            .hold
            .filter(|hold| !view.playing && hold.version != view.version)
        {
            room.hold =
                ((view.position - hold.position).abs() > SEEK_DISTANCE_SECS).then_some(Hold {
                    version: view.version,
                    position: view.position,
                }); // a seek keeps waiting; a pause means someone took over
        }
        let action = if room.applying || view.media_id.is_empty() {
            None
        } else if view.playing && waiting > 0 {
            Some(GateAction::Hold {
                position: room.lowest_position(view),
            })
        } else if view.playing {
            room.hold = None; // someone pressed play and everyone is ready
            None
        } else if room.hold.is_some() && waiting == 0 {
            Some(GateAction::Resume {
                position: view.position,
            })
        } else {
            None
        };
        room.applying = action.is_some();
        GateDecision {
            action,
            waiting_devices: waiting,
            holding: room.hold.is_some() || matches!(action, Some(GateAction::Hold { .. })),
        }
    }

    /// `new_version` is the room version after the action, `None` if it wasn't applied.
    pub fn finish_action(&self, room_id: &RoomId, action: GateAction, new_version: Option<i64>) {
        let mut rooms = self.rooms.lock();
        let Some(room) = rooms.get_mut(room_id) else {
            return;
        };
        room.applying = false;
        let Some(version) = new_version else {
            return;
        };
        room.hold = match action {
            GateAction::Hold { position } => Some(Hold { version, position }),
            GateAction::Resume { .. } => None,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MEDIA: &str = "med_a";

    fn room() -> RoomId {
        RoomId::expect_positive(1)
    }

    fn report(ready: bool, position: Option<f64>, version: i64) -> DeviceReport {
        DeviceReport {
            media_id: MEDIA.to_string(),
            participating: true,
            ready,
            position,
            state_version: version,
        }
    }

    fn view(playing: bool, position: f64, version: i64) -> RoomView<'static> {
        RoomView {
            media_id: MEDIA,
            playing,
            position,
            version,
        }
    }

    /// Applies an action the way the handler does and returns the room's next version.
    fn apply(gate: &PlaybackGate, decision: GateDecision, version: i64) -> i64 {
        let action = decision.action.expect("an action");
        gate.finish_action(&room(), action, Some(version + 1));
        version + 1
    }

    #[test]
    fn holds_at_the_lowest_position_and_resumes_when_everyone_is_ready() {
        let gate = PlaybackGate::new();
        let now = Instant::now();
        gate.report(&room(), "tv", report(false, Some(90.0), 5), now);
        gate.report(&room(), "phone", report(true, Some(100.0), 5), now);

        let decision = gate.decide(&room(), &view(true, 100.5, 5), now);
        assert_eq!(decision.action, Some(GateAction::Hold { position: 90.0 }));
        assert_eq!(decision.waiting_devices, 1);
        assert!(decision.holding);
        let version = apply(&gate, decision, 5);

        assert_eq!(
            gate.decide(&room(), &view(false, 90.0, version), now)
                .action,
            None
        );

        gate.report(&room(), "tv", report(true, Some(90.0), version), now);
        let decision = gate.decide(&room(), &view(false, 90.0, version), now);
        assert_eq!(decision.action, Some(GateAction::Resume { position: 90.0 }));
        let version = apply(&gate, decision, version);

        let decision = gate.decide(&room(), &view(true, 90.2, version), now);
        assert_eq!(decision.action, None);
        assert!(!decision.holding);
    }

    #[test]
    fn a_device_still_on_the_previous_video_counts_as_not_loaded() {
        let gate = PlaybackGate::new();
        let now = Instant::now();
        let mut old = report(true, Some(500.0), 5);
        old.media_id = "med_previous".to_string();
        gate.report(&room(), "tv", old, now);
        let decision = gate.decide(&room(), &view(true, 0.1, 6), now);
        // Its position belongs to the other video and must not move this one.
        assert_eq!(decision.action, Some(GateAction::Hold { position: 0.1 }));
    }

    #[test]
    fn a_position_from_an_older_room_state_is_ignored() {
        let gate = PlaybackGate::new();
        let now = Instant::now();
        // The room was just seeked forward and this device hasn't applied it yet.
        gate.report(&room(), "tv", report(false, Some(10.0), 4), now);
        let decision = gate.decide(&room(), &view(true, 300.0, 5), now);
        assert_eq!(decision.action, Some(GateAction::Hold { position: 300.0 }));
    }

    #[test]
    fn a_hold_rewinds_the_room_only_a_little() {
        let gate = PlaybackGate::new();
        let now = Instant::now();
        // A report far behind the room cannot pull everyone back to it.
        gate.report(&room(), "tv", report(false, Some(5.0), 5), now);
        let decision = gate.decide(&room(), &view(true, 600.0, 5), now);
        assert_eq!(decision.action, Some(GateAction::Hold { position: 570.0 }));
    }

    #[test]
    fn devices_that_do_not_play_here_never_hold_the_room() {
        let gate = PlaybackGate::new();
        let now = Instant::now();
        let mut remote = report(false, Some(3.0), 5);
        remote.participating = false;
        gate.report(&room(), "remote", remote, now);
        gate.report(&room(), "tv", report(true, Some(100.0), 5), now);
        let decision = gate.decide(&room(), &view(true, 100.0, 5), now);
        assert_eq!(decision.action, None);
        assert_eq!(decision.waiting_devices, 0);
    }

    #[test]
    fn a_paused_room_is_left_alone() {
        let gate = PlaybackGate::new();
        let now = Instant::now();
        gate.report(&room(), "tv", report(false, None, 5), now);
        let decision = gate.decide(&room(), &view(false, 10.0, 5), now);
        assert_eq!(decision.action, None);
        assert!(!decision.holding);
    }

    #[test]
    fn someone_pausing_during_a_hold_cancels_the_resume() {
        let gate = PlaybackGate::new();
        let now = Instant::now();
        gate.report(&room(), "tv", report(false, None, 5), now);
        let version = apply(&gate, gate.decide(&room(), &view(true, 10.0, 5), now), 5);

        let paused_by_user = version + 1;
        assert_eq!(
            gate.decide(&room(), &view(false, 10.0, paused_by_user), now)
                .action,
            None
        );
        gate.report(&room(), "tv", report(true, None, paused_by_user), now);
        let decision = gate.decide(&room(), &view(false, 10.0, paused_by_user), now);
        assert_eq!(decision.action, None);
        assert!(!decision.holding);
    }

    #[test]
    fn seeking_during_a_hold_keeps_waiting_at_the_new_position() {
        let gate = PlaybackGate::new();
        let now = Instant::now();
        gate.report(&room(), "tv", report(false, None, 5), now);
        let version = apply(&gate, gate.decide(&room(), &view(true, 10.0, 5), now), 5);

        let seeked = version + 1;
        let decision = gate.decide(&room(), &view(false, 20.0, seeked), now);
        assert_eq!(decision.action, None);
        assert!(decision.holding);

        // And again: this is what pressing +10 twice looks like.
        let seeked = seeked + 1;
        assert!(
            gate.decide(&room(), &view(false, 30.0, seeked), now)
                .holding
        );

        gate.report(&room(), "tv", report(true, Some(30.0), seeked), now);
        let decision = gate.decide(&room(), &view(false, 30.0, seeked), now);
        assert_eq!(decision.action, Some(GateAction::Resume { position: 30.0 }));
    }

    #[test]
    fn pausing_after_a_seek_during_a_hold_still_cancels_the_resume() {
        let gate = PlaybackGate::new();
        let now = Instant::now();
        gate.report(&room(), "tv", report(false, None, 5), now);
        let version = apply(&gate, gate.decide(&room(), &view(true, 10.0, 5), now), 5);
        assert!(
            gate.decide(&room(), &view(false, 20.0, version + 1), now)
                .holding
        );
        assert!(
            !gate
                .decide(&room(), &view(false, 20.2, version + 2), now)
                .holding
        );
    }

    #[test]
    fn pressing_play_during_a_hold_holds_again_until_ready() {
        let gate = PlaybackGate::new();
        let now = Instant::now();
        gate.report(&room(), "tv", report(false, None, 5), now);
        let version = apply(&gate, gate.decide(&room(), &view(true, 10.0, 5), now), 5);
        let pressed = version + 1;
        let decision = gate.decide(&room(), &view(true, 10.0, pressed), now);
        assert_eq!(decision.action, Some(GateAction::Hold { position: 10.0 }));
    }

    #[test]
    fn a_disconnected_device_releases_the_room() {
        let gate = PlaybackGate::new();
        let now = Instant::now();
        gate.report(&room(), "tv", report(false, None, 5), now);
        gate.report(&room(), "phone", report(true, Some(10.0), 5), now);
        let version = apply(&gate, gate.decide(&room(), &view(true, 10.0, 5), now), 5);
        gate.remove(&room(), "tv");
        let decision = gate.decide(&room(), &view(false, 10.0, version), now);
        assert_eq!(decision.action, Some(GateAction::Resume { position: 10.0 }));
    }

    #[test]
    fn a_device_that_stops_reporting_releases_the_room() {
        let gate = PlaybackGate::new();
        let now = Instant::now();
        gate.report(&room(), "tv", report(false, None, 5), now);
        gate.report(&room(), "phone", report(true, Some(10.0), 5), now);
        let version = apply(&gate, gate.decide(&room(), &view(true, 10.0, 5), now), 5);
        let later = now + REPORT_STALE_AFTER;
        gate.report(&room(), "phone", report(true, Some(10.0), version), later);
        let decision = gate.decide(&room(), &view(false, 10.0, version), later);
        assert_eq!(decision.action, Some(GateAction::Resume { position: 10.0 }));
    }

    #[test]
    fn a_device_that_cannot_load_stops_holding_after_the_limit_and_rejoins_when_ready() {
        let gate = PlaybackGate::new();
        let start = Instant::now();
        gate.report(&room(), "tv", report(false, None, 5), start);
        let version = apply(&gate, gate.decide(&room(), &view(true, 10.0, 5), start), 5);

        let mut now = start;
        while now.duration_since(start) < MAX_WAIT_FOR_DEVICE {
            assert_eq!(
                gate.decide(&room(), &view(false, 10.0, version), now)
                    .action,
                None
            );
            now += Duration::from_secs(5);
            gate.report(&room(), "tv", report(false, None, version), now);
        }
        let decision = gate.decide(&room(), &view(false, 10.0, version), now);
        assert_eq!(decision.action, Some(GateAction::Resume { position: 10.0 }));
        let version = apply(&gate, decision, version);

        // Still failing: the room plays on without it.
        gate.report(&room(), "tv", report(false, None, version), now);
        assert_eq!(
            gate.decide(&room(), &view(true, 11.0, version), now).action,
            None
        );

        // Ready again, then stalling again: it counts like any other device.
        gate.report(&room(), "tv", report(true, Some(11.0), version), now);
        assert_eq!(
            gate.decide(&room(), &view(true, 11.0, version), now).action,
            None
        );
        gate.report(&room(), "tv", report(false, Some(11.0), version), now);
        let decision = gate.decide(&room(), &view(true, 12.0, version), now);
        assert_eq!(decision.action, Some(GateAction::Hold { position: 11.0 }));
    }

    #[test]
    fn only_one_action_runs_at_a_time_and_a_failed_one_is_retried() {
        let gate = PlaybackGate::new();
        let now = Instant::now();
        gate.report(&room(), "tv", report(false, None, 5), now);
        let first = gate.decide(&room(), &view(true, 10.0, 5), now);
        let action = first.action.expect("hold");
        assert_eq!(gate.decide(&room(), &view(true, 10.0, 5), now).action, None);
        gate.finish_action(&room(), action, None);
        assert!(gate
            .decide(&room(), &view(true, 10.0, 5), now)
            .action
            .is_some());
    }

    #[test]
    fn a_room_without_reports_is_not_touched() {
        let gate = PlaybackGate::new();
        let decision = gate.decide(&room(), &view(true, 10.0, 5), Instant::now());
        assert_eq!(decision.action, None);
    }
}
