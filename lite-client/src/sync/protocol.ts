// Room WebSocket wire format (format=json): protobuf-JSON text frames, oneof
// members as keys, enums as integers, int64 as decimal strings, defaults omitted.
import type { Playback } from '../api/types';
import type { WirePlaybackState } from './state';

export const DELIVERY_PUSH_SNAPSHOT = 2;
export const HEARTBEAT_MS = 25_000;
export const CONNECT_TIMEOUT_MS = 10_000;
/** OptimisticLockConflict: rolled back silently (spec §5.4; mapping unverified). */
export const CONFLICT_CODE = 2003;

export const UPDATE_TYPE = { play: 1, pause: 2, seek: 3, speed: 4 } as const;
export type UpdateKind = keyof typeof UPDATE_TYPE;

export function wsUrl(origin: string, roomId: string, ticket: string): string {
  const base = origin.replace(/^http/, 'ws');
  return `${base}/ws/rooms/${encodeURIComponent(roomId)}?ticket=${encodeURIComponent(ticket)}&format=json`;
}

export function observeMessages(profile: Record<string, unknown>): unknown[] {
  return [
    { observeResource: { observeId: 'playback_state', deliveryMode: DELIVERY_PUSH_SNAPSHOT, playbackState: {} } },
    {
      observeResource: {
        observeId: 'playback',
        deliveryMode: DELIVERY_PUSH_SNAPSHOT,
        playback: { playbackClientProfile: profile },
      },
    },
  ];
}

export function heartbeatMessage(serverNowMs: number): unknown {
  return { heartbeat: { timestamp: String(Math.round(serverNowMs)) } };
}

export interface UpdateCommand {
  kind: UpdateKind;
  playing: boolean;
  /** Omitted for live sources. */
  position?: number;
  speed?: number;
  expectedMediaId: string;
  expectedPlaylistId: string;
  expectedTargetHash: string;
  opId: string;
  clientTimeMs: number;
}

export function playbackUpdateMessage(cmd: UpdateCommand): unknown {
  const msg: Record<string, unknown> = {
    type: UPDATE_TYPE[cmd.kind],
    playing: cmd.playing,
  };
  if (cmd.position !== undefined) msg.position = cmd.position;
  if (cmd.speed !== undefined) msg.speed = cmd.speed;
  // Expected-source guard: included only when non-empty (codec rule). `version`
  // is never sent by the official UI path, so neither do we.
  if (cmd.expectedMediaId) msg.expectedMediaId = cmd.expectedMediaId;
  if (cmd.expectedPlaylistId) msg.expectedPlaylistId = cmd.expectedPlaylistId;
  if (cmd.expectedTargetHash) msg.expectedTargetHash = cmd.expectedTargetHash;
  msg.clientOperationId = cmd.opId;
  msg.clientTimeMillis = String(Math.round(cmd.clientTimeMs));
  return { playbackStateUpdate: msg };
}

export type Incoming =
  | { kind: 'state'; state: WirePlaybackState }
  | { kind: 'playback'; playback: Playback }
  | { kind: 'error'; code: number; message: string; opId: string }
  | { kind: 'termination'; message: string; code: number }
  | { kind: 'other' };

export function parseIncoming(text: string): Incoming {
  let msg: Record<string, any>;
  try {
    msg = JSON.parse(text);
  } catch {
    return { kind: 'other' };
  }
  if (!msg || typeof msg !== 'object') return { kind: 'other' };
  const ev = msg.resourceEvent;
  if (ev && typeof ev === 'object') {
    if (ev.playbackState && ev.observeId === 'playback_state') return { kind: 'state', state: ev.playbackState };
    if (ev.playback && ev.observeId === 'playback') return { kind: 'playback', playback: ev.playback };
    // A `playback` observation with an empty Playback payload (playback cleared)
    // arrives as {} or with the key omitted entirely.
    if (ev.observeId === 'playback' && !ev.changedOnly) return { kind: 'playback', playback: ev.playback || {} };
    if (ev.observeId === 'playback_state' && !ev.changedOnly) return { kind: 'state', state: ev.playbackState || {} };
    return { kind: 'other' };
  }
  if (msg.error && typeof msg.error === 'object') {
    return {
      kind: 'error',
      code: Number(msg.error.code || 0),
      message: String(msg.error.message || 'Error'),
      opId: String(msg.error.clientOperationId || ''),
    };
  }
  if (msg.termination) {
    return { kind: 'termination', message: String(msg.termination.message || ''), code: Number(msg.termination.code || 0) };
  }
  return { kind: 'other' };
}

/**
 * RealtimeTerminationCode values meaning access to the room is gone
 * (USER/ROOM access revoked, membership revoked, guest revoked, room deleted,
 * banned, owner inactive). CONNECTION_REVOKED (1) and UNSPECIFIED reconnect;
 * if access really is gone the next ticket request fails with 403.
 */
export function terminationLosesAccess(code: number): boolean {
  return code >= 2 && code <= 8;
}

/** Live sources: PlaybackKind LIVE = 2 (integers on WS; names via HTTP). */
export function isLivePlayback(playback: Playback | undefined): boolean {
  const kind = playback && (playback.playbackKind as unknown);
  return kind === 2 || kind === 'PLAYBACK_KIND_LIVE';
}
