// Room WebSocket wire format (format=json): protobuf-JSON text frames, oneof
// members as keys, enums as integers, int64 as decimal strings, defaults omitted.
import type { Media, Playback } from '../api/types';
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

/** Same page size as listRootMedia, so a pushed list matches a fetched one. */
const PLAYLIST_PAGE_SIZE = 100;

export function observeMessages(
  profile: Record<string, unknown>,
  options: { roomDetails?: boolean; roomSettings?: boolean } = {},
): unknown[] {
  const messages: unknown[] = [
    { observeResource: { observeId: 'playback_state', deliveryMode: DELIVERY_PUSH_SNAPSHOT, playbackState: {} } },
    {
      observeResource: {
        observeId: 'playback',
        deliveryMode: DELIVERY_PUSH_SNAPSHOT,
        playback: { playbackClientProfile: profile },
      },
    },
  ];
  if (options.roomDetails) {
    messages.push(
      {
        observeResource: {
          observeId: 'playlist_items',
          deliveryMode: DELIVERY_PUSH_SNAPSHOT,
          playlistItems: { request: { pageSize: PLAYLIST_PAGE_SIZE } },
        },
      },
      { observeResource: { observeId: 'room_members', deliveryMode: DELIVERY_PUSH_SNAPSHOT, roomMemberEvents: {} } },
      { observeResource: { observeId: 'room_online', deliveryMode: DELIVERY_PUSH_SNAPSHOT, onlineEvent: {} } },
    );
  }
  if (options.roomDetails || options.roomSettings) {
    messages.push({ observeResource: { observeId: 'room_settings', deliveryMode: DELIVERY_PUSH_SNAPSHOT, roomSettings: {} } });
  }
  return messages;
}

export function heartbeatMessage(serverNowMs: number): unknown {
  return { heartbeat: { timestamp: String(Math.round(serverNowMs)) } };
}

export interface PlayerStatus {
  mediaId: string;
  participating: boolean;
  ready: boolean;
  /** Omitted until the player has caught up with the room. */
  position?: number;
  stateVersion: number;
}

export function playerStatusMessage(status: PlayerStatus): unknown {
  const msg: Record<string, unknown> = {
    mediaId: status.mediaId,
    participating: status.participating,
    ready: status.ready,
    stateVersion: String(status.stateVersion),
  };
  if (status.position !== undefined) msg.position = status.position;
  return { playerStatus: msg };
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


export interface TvSubtitles {
  enabled: boolean;
  track: string;
}

/** An older room's settings may lack this: on. Once present, false and "" are omitted on the wire. */
function parseTvSubtitles(wire: { enabled?: boolean; track?: string } | undefined): TvSubtitles {
  return wire ? { enabled: !!wire.enabled, track: wire.track || '' } : { enabled: true, track: '' };
}

export type Incoming =
  | { kind: 'state'; state: WirePlaybackState }
  | { kind: 'playback'; playback: Playback }
  | { kind: 'playlist'; media: Media[] }
  | { kind: 'settings'; autoPlay: boolean; tvSubtitles: TvSubtitles }
  | { kind: 'members' }
  | { kind: 'gate'; waitingDevices: number; holding: boolean }
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
  if (msg.playbackGate && typeof msg.playbackGate === 'object') {
    return {
      kind: 'gate',
      waitingDevices: Number(msg.playbackGate.waitingDevices) || 0,
      holding: !!msg.playbackGate.holding,
    };
  }
  const ev = msg.resourceEvent;
  if (ev && typeof ev === 'object') {
    if (ev.playbackState && ev.observeId === 'playback_state') return { kind: 'state', state: ev.playbackState };
    if (ev.playback && ev.observeId === 'playback') return { kind: 'playback', playback: ev.playback };
    // A `playback` observation with an empty Playback payload (playback cleared)
    // arrives as {} or with the key omitted entirely.
    if (ev.observeId === 'playback' && !ev.changedOnly) return { kind: 'playback', playback: ev.playback || {} };
    if (ev.observeId === 'playback_state' && !ev.changedOnly) return { kind: 'state', state: ev.playbackState || {} };
    // An empty playlist omits `media`, or the whole payload.
    if (ev.observeId === 'playlist_items' && !ev.changedOnly) return { kind: 'playlist', media: ev.playlistItems?.media || [] };
    if (ev.observeId === 'room_settings' && ev.roomSettings) {
      const settings = ev.roomSettings.settings;
      return { kind: 'settings', autoPlay: !!settings?.autoPlay?.enabled, tvSubtitles: parseTvSubtitles(settings?.tvSubtitles) };
    }
    if (ev.observeId === 'room_members' && ev.roomMemberEvent) return { kind: 'members' };
    // Coming and going changes who is watching. A newly paired TV joins silently: coming online is its first sign.
    if (ev.observeId === 'room_online' && ev.onlineEvent) return { kind: 'members' };
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
