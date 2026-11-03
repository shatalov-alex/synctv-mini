// Authoritative room playback state and the pure sync decisions, ported from
// the official client (synctv_models.dart, playback_sync_target.dart,
// room_screen.dart _performSync / _retryAutomaticPlaybackSync).

export const AUTO_SEEK_THRESHOLD_S = 1.2;
export const MANUAL_SEEK_THRESHOLD_S = 0.2;
export const SYNC_LOOP_MS = 2000;
export const SYNC_COOLDOWN_MS = 800;

export interface SyncState {
  mediaId: string;
  playlistId: string;
  targetHash: string;
  playing: boolean;
  /** Seconds, valid at `generatedAtMs` (server clock). */
  position: number;
  speed: number;
  /** Server unix ms when `position` was computed; 0 = unknown. */
  generatedAtMs: number;
  version: number;
  /** Originating client operation id, '' if none. */
  opId: string;
}

export interface WirePlaybackState {
  playingMediaId?: string;
  playingPlaylistId?: string;
  targetHash?: string;
  isPlaying?: boolean;
  position?: number;
  speed?: number;
  generatedAtMillis?: string | number;
  version?: string | number;
  clientOperationId?: string;
}

function num(value: string | number | undefined): number {
  const n = Number(value === undefined || value === null || value === '' ? 0 : value);
  return isFinite(n) ? n : 0;
}

/** pbjson omits defaults: missing = 0 / "" / false. speed 0 means 1 (codec rule). */
export function stateFromWire(wire: WirePlaybackState): SyncState {
  const speed = num(wire.speed);
  return {
    mediaId: wire.playingMediaId || '',
    playlistId: wire.playingPlaylistId || '',
    targetHash: wire.targetHash || '',
    playing: !!wire.isPlaying,
    position: num(wire.position),
    speed: speed > 0 ? speed : 1,
    generatedAtMs: num(wire.generatedAtMillis),
    version: num(wire.version),
    opId: wire.clientOperationId || '',
  };
}

export function sameSource(a: SyncState | null, b: SyncState | null): boolean {
  if (!a || !b) return false;
  return a.mediaId === b.mediaId && a.playlistId === b.playlistId && a.targetHash === b.targetHash;
}

export function hasSource(s: SyncState | null): boolean {
  return !!s && (!!s.mediaId || !!s.playlistId);
}

/** Version guard: drop strictly older states; equal versions apply. */
export function isStale(incoming: SyncState, current: SyncState | null): boolean {
  return !!current && incoming.version < current.version;
}

export interface ExpectedPosition {
  position: number;
  atEnd: boolean;
}

/** Where the room is "now" in server time. `duration` 0 = unknown. */
export function expectedPosition(s: SyncState, serverNowMs: number, duration: number): ExpectedPosition {
  let p = isFinite(s.position) && s.position > 0 ? s.position : 0;
  if (s.playing && s.generatedAtMs > 0) {
    p += (Math.max(0, serverNowMs - s.generatedAtMs) / 1000) * s.speed;
  }
  if (p <= 0) return { position: 0, atEnd: false };
  if (duration > 0 && p >= duration) return { position: duration, atEnd: true };
  return { position: p, atEnd: false };
}

export interface PlayerView {
  currentTime: number;
  paused: boolean;
  playbackRate: number;
  duration: number;
}

export interface SyncPlan {
  /** New playbackRate, or null to keep. */
  rate: number | null;
  pause: boolean;
  /** Seek target in seconds (ms-truncated), or null. */
  seek: number | null;
  play: boolean;
}

export interface SyncOptions {
  forceSeek?: boolean;
  live?: boolean;
  freeMode?: boolean;
}

/** One _performSync pass: rate → pause → seek → play. */
export function planSync(s: SyncState, player: PlayerView, serverNowMs: number, opts: SyncOptions = {}): SyncPlan {
  const rate = Math.abs(player.playbackRate - s.speed) > 1e-9 ? s.speed : null;
  const target = opts.live ? null : expectedPosition(s, serverNowMs, player.duration);
  const wantPlay = target && target.atEnd ? false : s.playing;
  let seek: number | null = null;
  if (target) {
    const drift = Math.abs(player.currentTime - target.position);
    const autoSeek = target.atEnd || (!opts.freeMode && drift > AUTO_SEEK_THRESHOLD_S);
    const manualSeek = !!opts.forceSeek && drift >= MANUAL_SEEK_THRESHOLD_S;
    if (autoSeek || manualSeek) seek = Math.floor(target.position * 1000) / 1000;
  }
  return {
    rate,
    pause: !wantPlay && !player.paused,
    seek,
    play: wantPlay && player.paused,
  };
}

/** The 2 s retry loop's trigger condition (no force). */
export function needsCorrection(s: SyncState, player: PlayerView, serverNowMs: number, opts: SyncOptions = {}): boolean {
  if (opts.freeMode) return false;
  const target = opts.live ? null : expectedPosition(s, serverNowMs, player.duration);
  const wantPlay = target && target.atEnd ? false : s.playing;
  const posBad = !!target && Math.abs(player.currentTime - target.position) > AUTO_SEEK_THRESHOLD_S;
  return wantPlay !== !player.paused || posBad;
}

/** Reconnect delay: attempts = min(attempts + 1, 5); delay = attempts × 2 s. */
export function nextReconnect(attempts: number): { attempts: number; delayMs: number } {
  const next = Math.min(attempts + 1, 5);
  return { attempts: next, delayMs: next * 2000 };
}
