// Room sync engine: a port of the official SyncTV client's playback sync
// (room_screen.dart). See README "Sync" for the behaviour and deviations.
//
// Invariants (spec §5.1/§5.3): only UI gestures send commands; player events
// never do. Our own echoes are stored but not re-applied to the player.
import { ApiError, type ApiClient } from '../api/http';
import { getPlayback, playNext, playPrevious, reportMediaDuration } from '../api/endpoints';
import type { Playback } from '../api/types';
import type { VideoPlayer } from '../player/player';
import { pickSource, type PlayableSource } from '../player/source';
import { ServerClock, TIME_SYNC_TIMEOUT_MS } from './clock';
import { OpTracker, uuidv4 } from './ops';
import { buildClientProfile } from './profile';
import {
  CONFLICT_CODE,
  CONNECT_TIMEOUT_MS,
  HEARTBEAT_MS,
  heartbeatMessage,
  isLivePlayback,
  observeMessages,
  parseIncoming,
  playbackUpdateMessage,
  terminationLosesAccess,
  wsUrl,
  type UpdateKind,
  playerStatusMessage,
  type PlayerStatus,
} from './protocol';
import {
  expectedPosition,
  hasSource,
  isStale,
  needsCorrection,
  nextReconnect,
  planSync,
  sameSource,
  stateFromWire,
  SYNC_COOLDOWN_MS,
  SYNC_LOOP_MS,
  type SyncState,
  AUTO_SEEK_THRESHOLD_S,
  READY_BUFFER_S,
  MAX_PULL_BACK_S,
  STALL_GRACE_MS,
  nextReady,
  shouldPullBack,
} from './state';
import type { SyncEngine, SyncSnapshot } from './types';

const INIT_TIMEOUT_MS = 20_000;
/**
 * Hidden longer than this (Telegram minimised, phone locked): the socket may
 * be a zombie that still reports OPEN, so reconnect on return. A reconnect is
 * cheap: observing re-sends the full state.
 */
export const BACKGROUND_RECONNECT_MS = 15_000;
/** Past the sync cooldown, so the first frames have played before measuring drift. */
const SETTLE_DELAY_MS = SYNC_COOLDOWN_MS + 200;
/** The room's position differs from where it should have got to by this much: someone moved it. */
const ROOM_JUMP_S = 0.5;
const AUTO_SYNC_TRIES = 4;
const MAX_ERROR_RELOADS = 3;
const PULL_BACK_WAIT_MS = 4000;
/** Reloads this far apart are separate incidents (e.g. each 30 min URL expiry of a long film). */
const ERROR_RELOAD_WINDOW_MS = 60_000;
/** "Completed" tolerance for play-from-end (custom_video_player.dart:1769). */
const ENDED_TOLERANCE_S = 0.5;

interface Resolved {
  mediaId: string;
  playlistId: string;
  source: PlayableSource | null;
  live: boolean;
  /** The server already knows the media's length (`playback.durationSeconds`). */
  durationKnown: boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface RoomSyncEngineOptions {
  /** http(s) origin of the server; defaults to the page origin. */
  origin?: string;
  /** Disables auto-seek and the 2 s loop (official "free mode"); default false. */
  freeMode?: boolean;
  /** Start in remote mode (no local playback). */
  remote?: boolean;
  /** Keep the playlist, autoplay and member changes current; for pages that show them. */
  roomDetails?: boolean;
  /** Only the room's settings, for a TV, which has no use for the rest of `roomDetails`. */
  roomSettings?: boolean;
}

export class RoomSyncEngine implements SyncEngine {
  private roomId = '';
  private disposed = false;
  /** Access to the room is gone: never reconnect. */
  private lost = false;
  private listeners: Array<(s: SyncSnapshot) => void> = [];
  private snap: SyncSnapshot = {
    connection: 'idle',
    state: null,
    source: null,
    live: false,
    autoMuted: false,
    needsGesture: false,
    error: null,
    navigating: false,
    accessLost: null,
    remote: false,
    waitingDevices: 0,
    playlist: null,
    autoPlay: null,
    tvSubtitles: null,
    memberChanges: 0,
  };

  // sync state
  private cur: SyncState | null = null;
  private resolved: Resolved | null = null;
  private loadedKey: string | null = null;
  private loadedReady = false;
  private errorReloads = 0;
  private lastErrorReloadAt = 0;
  /** Gave up reloading this source; a new `playback` resource may bring a working link. */
  private playbackFailed = false;
  /** Media whose duration this engine already reported: one attempt each, never retried. */
  private readonly reportedDurations = new Set<string>();
  private syncGen = 0;
  private syncing = false;
  private loadGen = 0;
  private readonly ops = new OpTracker<SyncState>(60_000);
  private readonly clock: ServerClock;
  private loopTimer: ReturnType<typeof setInterval> | null = null;

  // connection state
  private ws: WebSocket | null = null;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly origin: string;
  private readonly freeMode: boolean;
  private readonly observesRoomDetails: boolean;
  private readonly observesRoomSettings: boolean;
  private readonly unsubscribePlayer: () => void;
  private hiddenAt = 0;
  /** A forced seek+play is waiting for playback to actually start (see settle()). */
  private settlePending = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private autoSyncTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped per openSocket so an older, slower ticket request can't open a second socket. */
  private connectGen = 0;
  private lifecycleBound = false;
  /** What the room's gate knows about this device (see reportStatus()). */
  private deviceReady = false;
  private stalledSince = 0;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  /** The player has been within the sync threshold since it (re)joined; only then does its position count. */
  private caughtUp = false;
  private pulling = false;
  private lastPullAt = 0;
  private lastStatus = '';
  /** Room state version the player has been moved to; its position means nothing for a newer one. */
  private syncedVersion = -1;

  constructor(
    private readonly api: ApiClient,
    private readonly player: VideoPlayer,
    options: RoomSyncEngineOptions = {},
  ) {
    this.origin = options.origin || location.origin;
    this.freeMode = !!options.freeMode;
    this.observesRoomDetails = !!options.roomDetails;
    this.observesRoomSettings = !!options.roomSettings;
    if (options.remote) {
      this.snap = { ...this.snap, remote: true };
      player.setPreload('metadata');
    }
    this.clock = new ServerClock((sent) =>
      withTimeout(
        api.request('GET', '/api/public/time', undefined, { auth: false, query: { clientSentAtNanos: sent } }),
        TIME_SYNC_TIMEOUT_MS,
      ),
    );
    // Player events only update UI flags and drive error recovery; they never send.
    this.unsubscribePlayer = player.on((event) => {
      if (event.type === 'mutedautoplay') this.update({ autoMuted: true, needsGesture: false });
      else if (event.type === 'autoplayblocked') this.update({ needsGesture: true });
      else if (event.type === 'error') this.onPlayerError(event.message || 'Playback error');
      else if (event.type === 'playing') this.settle();
      this.onPlayerProgress(event.type);
    });
  }

  // ---------------- public API ----------------

  connect(roomId: string): void {
    this.roomId = roomId;
    this.clock.start();
    if (this.loopTimer === null) this.loopTimer = setInterval(() => this.retryLoop(), SYNC_LOOP_MS);
    this.bindLifecycle(true);
    void this.openSocket();
  }

  onState(listener: (s: SyncSnapshot) => void): () => void {
    this.listeners.push(listener);
    listener(this.snap);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  snapshot(): SyncSnapshot {
    return this.snap;
  }

  play(): void {
    this.userAction('play');
  }
  pause(): void {
    this.userAction('pause');
  }
  seek(seconds: number): void {
    this.userAction('seek', seconds);
  }
  setRate(rate: number): void {
    this.userAction('speed', rate);
  }

  next(): Promise<void> {
    return this.navigate(playNext);
  }
  prev(): Promise<void> {
    return this.navigate(playPrevious);
  }

  syncNow(): void {
    const cur = this.cur;
    if (!cur) return;
    if (this.snap.live && this.resolved && this.resolved.source) {
      this.loadedKey = null; // live: reload the URL instead of seeking
      void this.apply(cur, { forceSeek: true });
      return;
    }
    void this.performSync(cur, true);
  }

  unlock(): void {
    this.restoreAudio();
    this.update({ needsGesture: false });
    // Not loaded yet (iOS may hold back loading until a gesture): start the
    // element inside this tap; the forced sync after metadata fixes position.
    if (!this.loadedReady && this.cur && this.cur.playing && this.player.currentSource) {
      void this.player.play();
      return;
    }
    if (this.cur) void this.performSync(this.cur, true);
  }

  setRemote(on: boolean): void {
    if (on === this.snap.remote) return;
    this.update({ remote: on, needsGesture: false });
    if (on) {
      this.settlePending = false;
      this.player.setPreload('metadata');
      this.player.pause();
      return;
    }
    // Called from a tap: playing here is allowed, with sound.
    this.player.setPreload('auto');
    this.restoreAudio();
    if (this.cur) void this.performSync(this.cur, true);
  }

  position(): number {
    if (!this.snap.remote) return this.player.currentTime;
    const cur = this.cur;
    if (!cur) return 0;
    return expectedPosition(cur, this.clock.now(), this.player.duration).position;
  }

  dispose(): void {
    this.disposed = true;
    this.bindLifecycle(false);
    if (this.autoSyncTimer !== null) clearTimeout(this.autoSyncTimer);
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    if (this.stallTimer !== null) clearTimeout(this.stallTimer);
    this.clock.stop();
    if (this.loopTimer !== null) clearInterval(this.loopTimer);
    this.loopTimer = null;
    this.clearReconnect();
    this.closeSocket();
    this.unsubscribePlayer();
    this.listeners = [];
  }

  // ---------------- applying remote state (spec §4) ----------------

  private async apply(s: SyncState, opts: { forceSeek?: boolean; skipPlayerSync?: boolean } = {}): Promise<void> {
    if (isStale(s, this.cur)) return;
    this.pulling = false;
    const prev = this.cur;
    const sourceChanged = !!prev && !sameSource(prev, s);
    // Deviation from the official client: seek precisely (0.2 s) while the room
    // is paused, when it starts playing and when its speed changes. These are
    // jumps anyway, and a sub-1.2 s offset left there would otherwise carry
    // into the whole film.
    const precise = !s.playing || (!!prev && (!prev.playing || prev.speed !== s.speed));
    const moved = !!prev && sameSource(prev, s) && ((prev.playing && !s.playing) || this.roomJumped(prev, s));
    this.cur = s;
    if (!hasSource(s)) {
      this.unload();
      this.update({ state: s, source: null, live: false });
      return;
    }
    const res = this.resolvedFor(s);
    this.update({ state: s, source: res ? res.source : null, live: res ? res.live : false });
    this.reportStatus(false); // before anything starts, so the room can hold in time
    if (!res || !res.source) return; // wait for the `playback` resource
    const needLoad = res.source.key !== this.loadedKey;
    if (opts.skipPlayerSync && !needLoad) {
      this.syncedVersion = s.version; // our own command: the player is already there
      return;
    }
    if (needLoad) {
      await this.load(res.source);
      return;
    }
    if (moved) this.scheduleAutoSync();
    await this.performSync(s, !!opts.forceSeek || sourceChanged || precise);
  }

  /** `playback` resource: player-ready source, no timing (merge keeps current timing). */
  private onPlayback(playback: Playback): void {
    this.resolved = {
      mediaId: playback.mediaId || '',
      playlistId: playback.playlistId || '',
      source: pickSource(playback),
      live: isLivePlayback(playback),
      durationKnown: (playback.durationSeconds ?? 0) > 0,
    };
    if (this.resolved.mediaId && !this.resolved.source) {
      this.update({ error: 'This media has no source this player can open (needs HLS or a direct video file).' });
    }
    if (this.playbackFailed && this.resolved.source?.key === this.loadedKey) {
      // Its link was replaced while the player was stuck on the old one. Same media, so
      // load() puts the player back at the room's position.
      this.playbackFailed = false;
      this.errorReloads = 0;
      this.update({ error: null });
      void this.load(this.resolved.source);
      return;
    }
    if (this.cur) void this.apply(this.cur);
  }

  /**
   * Accept the resolved entry only when it matches the current source
   * identity, so an older resource can't override a newer state. Tolerates
   * either arrival order of `playback_state` and `playback` (ambiguity 3).
   */
  private resolvedFor(s: SyncState): Resolved | null {
    const r = this.resolved;
    if (!r) return null;
    return r.mediaId === s.mediaId && r.playlistId === s.playlistId ? r : null;
  }

  private async load(source: PlayableSource): Promise<void> {
    const gen = ++this.loadGen;
    if (source.key !== this.loadedKey) this.errorReloads = 0;
    this.playbackFailed = false;
    this.loadedKey = source.key;
    this.loadedReady = false;
    this.caughtUp = false;
    if (source.requiresHeaders) {
      this.update({ error: 'This source needs custom request headers, which browsers cannot send to <video>.' });
    }
    await this.player.load(source);
    // A slow link can take longer than one wait. The error path or a newer load ends this.
    while (!(await this.waitForMetadata(gen))) {
      if (gen !== this.loadGen || this.disposed) return;
    }
    if (gen !== this.loadGen || this.disposed) return;
    this.loadedReady = true;
    this.reportDuration();
    if (this.cur) await this.performSync(this.cur, true); // initial join / media change: forced
  }

  /**
   * Tell the server the length the player just learned when it has none (direct
   * URLs), so the playback resource, auto-advance and the timeline know it.
   * Fire-and-forget: a refusal (no playback permission) or failure is not retried.
   */
  private reportDuration(): void {
    const r = this.cur ? this.resolvedFor(this.cur) : null;
    if (!r || r.live || r.durationKnown || !r.mediaId || this.reportedDurations.has(r.mediaId)) return;
    const duration = this.player.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    this.reportedDurations.add(r.mediaId);
    reportMediaDuration(this.api, this.roomId, r.mediaId, duration).catch(() => {});
  }

  private waitForMetadata(gen: number): Promise<boolean> {
    if (this.player.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        resolve(ok);
      };
      const off = this.player.on((event) => {
        if (gen !== this.loadGen) finish(false);
        else if (event.type === 'loadedmetadata' || event.type === 'canplay') finish(true);
      });
      const timer = setTimeout(() => finish(this.player.ready), INIT_TIMEOUT_MS);
    });
  }

  private unload(): void {
    if (this.loadedKey === null) return;
    this.loadGen++;
    this.loadedKey = null;
    this.loadedReady = false;
    void this.player.load(null);
  }

  /** One sync pass: rate → pause → seek → play, then an 800 ms cooldown. */
  private async performSync(s: SyncState, forceSeek = false): Promise<void> {
    if (!this.loadedReady || !this.player.ready) return;
    if (this.snap.remote) {
      this.player.pause(); // remote mode: the element only provides the duration
      return;
    }
    const gen = ++this.syncGen;
    const isCurrent = () => gen === this.syncGen && this.cur === s && !this.disposed;
    this.syncing = true;
    try {
      const plan = planSync(s, this.playerView(), this.clock.now(), {
        forceSeek,
        live: this.snap.live,
        freeMode: this.freeMode,
      });
      if (plan.rate !== null) this.player.setRate(plan.rate);
      if (plan.pause) this.player.pause();
      if (plan.seek !== null) this.seekPlayer(plan.seek);
      this.syncedVersion = s.version;
      this.reportStatus(false);
      if (!isCurrent()) return;
      if (plan.play) {
        // Seek + start (join, media change, resync): the time spent buffering
        // before frames move is lost, so check once more after it starts.
        if (forceSeek && plan.seek !== null) this.settlePending = true;
        await this.player.play(); // muted autoplay fallback lives in the player
      }
    } finally {
      setTimeout(() => {
        if (gen === this.syncGen) this.syncing = false;
      }, SYNC_COOLDOWN_MS);
    }
  }

  /**
   * Deviation from the official client: a forced seek+play lands late by the
   * buffering time (0.3–0.8 s on phones), which the 1.2 s loop never fixes.
   * Once playback really starts, re-sync at the manual 0.2 s threshold — once,
   * so a slow source can't loop.
   */
  private settle(): void {
    if (!this.settlePending || this.snap.remote) return;
    this.settlePending = false;
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      const cur = this.cur;
      if (this.disposed || this.syncing || !cur || !cur.playing || this.player.paused || this.player.buffering) return;
      void this.performSync(cur, true).then(() => {
        this.settlePending = false; // this pass's own seek+play doesn't settle again
      });
    }, SETTLE_DELAY_MS);
  }

  private roomJumped(prev: SyncState, s: SyncState): boolean {
    const expected = expectedPosition(prev, s.generatedAtMs, this.player.duration).position;
    return Math.abs(expected - s.position) > ROOM_JUMP_S;
  }

  /**
   * The room was paused or moved: press "Sync" once the jump has landed. During playback only
   * when the room's position is already loaded: seeking to a part that isn't lands late, and
   * further off than it started. A few tries per change, so a slow device doesn't loop.
   */
  private scheduleAutoSync(attempt = 0): void {
    if (this.autoSyncTimer !== null) clearTimeout(this.autoSyncTimer);
    this.autoSyncTimer = setTimeout(() => {
      this.autoSyncTimer = null;
      const cur = this.cur;
      if (this.disposed || !cur || this.snap.remote || this.snap.live || this.freeMode) return;
      if (cur.playing && !this.canSeekPrecisely(cur)) {
        if (attempt + 1 < AUTO_SYNC_TRIES) this.scheduleAutoSync(attempt + 1);
        return;
      }
      void this.performSync(cur, true);
    }, SETTLE_DELAY_MS);
  }

  private canSeekPrecisely(s: SyncState): boolean {
    if (this.player.buffering || this.player.seeking) return false;
    const target = expectedPosition(s, this.clock.now(), this.player.duration).position;
    const ahead = target - this.player.currentTime;
    return ahead <= 0 || ahead < this.player.bufferedAhead;
  }

  private retryLoop(): void {
    this.correct();
    this.reportStatus(true);
  }

  private correct(): void {
    if (this.snap.remote) return;
    if (this.syncing || this.freeMode || !this.cur || !this.loadedReady || !this.player.ready) return;
    if (!this.resolvedFor(this.cur)) return;
    if (!this.snap.live) {
      const now = this.clock.now();
      const drift = Math.abs(this.player.currentTime - expectedPosition(this.cur, now, this.player.duration).position);
      if (drift > MAX_PULL_BACK_S) this.caughtUp = false;
      else if (drift <= AUTO_SEEK_THRESHOLD_S) this.caughtUp = true;
      if (this.pulling && Date.now() - this.lastPullAt < PULL_BACK_WAIT_MS) return; // the room is about to move back
      this.pulling = false;
      if (this.caughtUp && shouldPullBack(this.cur, this.playerView(), now, Date.now() - this.lastPullAt)) {
        this.lastPullAt = Date.now();
        this.pulling = true;
        return;
      }
    }
    if (needsCorrection(this.cur, this.playerView(), this.clock.now(), { live: this.snap.live })) {
      void this.performSync(this.cur);
    }
  }

  private playerView() {
    return {
      currentTime: this.player.currentTime,
      paused: this.player.paused,
      playbackRate: this.player.playbackRate,
      duration: this.player.duration,
    };
  }

  /** A jump to a part that isn't buffered: the room shouldn't play on before it has loaded. */
  private seekPlayer(target: number): void {
    const from = this.player.currentTime;
    this.player.seek(target);
    if (Math.abs(target - from) > AUTO_SEEK_THRESHOLD_S && this.player.bufferedAhead < READY_BUFFER_S) {
      this.deviceReady = false;
    }
  }

  private onPlayerProgress(type: string): void {
    if (type === 'waiting') {
      if (!this.stalledSince) this.stalledSince = Date.now();
      if (this.stallTimer === null) {
        this.stallTimer = setTimeout(() => {
          this.stallTimer = null;
          this.reportStatus(false);
        }, STALL_GRACE_MS);
      }
    } else if (type === 'playing' || type === 'canplay' || type === 'seeked' || type === 'pause') {
      this.stalledSince = 0;
    }
    if (type !== 'timeupdate') this.reportStatus(false);
  }

  /**
   * Tells the room whether this device can play, so it holds until everyone can. `always` is
   * the periodic report, which also shows the server this device is still there.
   */
  private reportStatus(always: boolean): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return;
    const status = this.playerStatus();
    const key = JSON.stringify({ ...status, position: undefined });
    if (!always && key === this.lastStatus) return;
    this.lastStatus = key;
    this.send(playerStatusMessage(status));
  }

  private playerStatus(): PlayerStatus {
    const s = this.cur;
    const resolved = s ? this.resolvedFor(s) : null;
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const participating =
      !!s &&
      hasSource(s) &&
      (!resolved || !!resolved.source) &&
      !this.snap.remote &&
      !this.snap.live &&
      !this.freeMode &&
      !this.snap.needsGesture &&
      !this.playbackFailed &&
      !hidden;
    const loaded = this.loadedReady && !!resolved && resolved.source?.key === this.loadedKey;
    this.deviceReady = nextReady(this.deviceReady, {
      loaded,
      paused: this.player.paused,
      seeking: this.player.seeking,
      buffering: this.player.buffering,
      stalledMs: this.stalledSince ? Date.now() - this.stalledSince : 0,
      readyState: this.player.readyState,
      bufferedAhead: this.player.bufferedAhead,
      atEnd: !!s && expectedPosition(s, this.clock.now(), this.player.duration).atEnd,
    });
    return {
      mediaId: loaded && resolved ? resolved.mediaId : '',
      participating,
      ready: this.deviceReady && !this.pulling,
      position: loaded && this.caughtUp && !!s && this.syncedVersion === s.version ? this.player.currentTime : undefined,
      stateVersion: s ? s.version : 0,
    };
  }

  private onPlayerError(message: string): void {
    const source = this.player.currentSource;
    const now = Date.now();
    if (now - this.lastErrorReloadAt > ERROR_RELOAD_WINDOW_MS) this.errorReloads = 0;
    if (source && this.errorReloads < MAX_ERROR_RELOADS) {
      this.errorReloads++;
      this.lastErrorReloadAt = now;
      void this.reloadFresh(source); // then a forced sync once ready
      return;
    }
    this.playbackFailed = true;
    this.update({ error: message });
  }

  /**
   * Reload after a playback error with a freshly issued URL: proxied URLs are
   * signed for 30 min, so after that a seek in a long film gets refused, and
   * reloading the same URL would fail again. Falls back to the old URL.
   */
  private async reloadFresh(source: PlayableSource): Promise<void> {
    const gen = this.loadGen;
    let next = source;
    try {
      const res = await getPlayback(this.api, this.roomId);
      const fresh = res.playback ? pickSource(res.playback) : null;
      if (fresh && fresh.key === source.key) {
        next = fresh;
        if (this.resolved && res.playback) this.resolved = { ...this.resolved, source: fresh };
      }
    } catch {
      // keep the old URL
    }
    if (this.disposed || gen !== this.loadGen) return; // something else loaded meanwhile
    await this.load(next);
  }

  // ---------------- local gestures (spec §5) ----------------

  private userAction(kind: UpdateKind, arg?: number): void {
    const cur = this.cur;
    const remote = this.snap.remote;
    // Remote mode needs no loaded player: positions come from the room clock.
    if (!cur || (!remote && (!this.loadedReady || !this.player.ready))) return;
    if (remote && !hasSource(cur)) return;
    const live = this.snap.live;
    if (live && kind === 'seek') return;
    if (!remote) this.restoreAudio();
    this.errorReloads = 0;
    const duration = this.player.duration;
    const clamp = (t: number) => Math.max(0, duration > 0 ? Math.min(t, duration) : t);
    const here = this.position();

    // 1) apply locally first (remote mode: nothing plays here)
    let playing = cur.playing;
    if (remote) {
      if (kind === 'play') playing = true;
      else if (kind === 'pause') playing = false;
    } else if (kind === 'play') {
      if (duration > 0 && this.player.currentTime >= duration - ENDED_TOLERANCE_S) this.player.seek(0);
      void this.player.play();
      playing = true;
    } else if (kind === 'pause') {
      this.player.pause();
      playing = false;
    } else if (kind === 'seek') {
      this.seekPlayer(clamp(arg || 0));
      // restore the expected play state after the seek
      if (cur.playing && this.player.paused) void this.player.play();
      else if (!cur.playing && !this.player.paused) this.player.pause();
    } else if (kind === 'speed' && arg) {
      this.player.setRate(arg);
    }

    // 2) command
    const opId = uuidv4();
    const t = Math.round(this.clock.now());
    let position = clamp(kind === 'seek' ? arg || 0 : here);
    // Play from the end restarts (the local branch seeks the player to 0).
    if (kind === 'play' && duration > 0 && here >= duration - ENDED_TOLERANCE_S) position = 0;
    const message = playbackUpdateMessage({
      kind,
      playing,
      position: live ? undefined : position,
      speed: kind === 'speed' ? arg : undefined,
      expectedMediaId: cur.mediaId,
      expectedPlaylistId: cur.playlistId,
      expectedTargetHash: cur.targetHash,
      opId,
      clientTimeMs: t,
    });

    // 3) optimistic state + tracker
    this.ops.remember(opId, cur);
    const optimistic: SyncState = {
      ...cur,
      playing,
      position: live ? cur.position : position,
      speed: kind === 'speed' && arg ? arg : remote ? cur.speed : this.player.playbackRate,
      generatedAtMs: t,
      opId,
    };
    this.cur = optimistic;
    this.update({ state: optimistic, error: null });
    if (!this.send(message)) {
      const r = this.ops.reject(opId);
      if (r.state) void this.apply(r.state, { forceSeek: true });
    }
    this.reportStatus(false);
    if (kind === 'pause' || kind === 'seek') this.scheduleAutoSync();
  }

  private async navigate(call: (api: ApiClient, roomId: string, playing: boolean) => Promise<unknown>): Promise<void> {
    if (this.snap.navigating || !this.roomId) return;
    this.update({ navigating: true });
    try {
      await call(this.api, this.roomId, !!this.snap.autoPlay); // response ignored: state arrives over the socket
    } catch (error) {
      this.update({ error: error instanceof Error ? error.message : 'Request failed' });
    } finally {
      this.update({ navigating: false });
    }
  }

  private restoreAudio(): void {
    if (this.snap.autoMuted) {
      this.player.setMuted(false);
      this.update({ autoMuted: false });
    }
  }

  // ---------------- incoming ----------------

  private onMessage(text: string): void {
    const msg = parseIncoming(text);
    if (msg.kind === 'state') {
      const s = stateFromWire(msg.state);
      const r = this.ops.acknowledge(s.opId, s);
      if (!r.handled) void this.apply(s);
      else if (r.state) void this.apply(r.state, { skipPlayerSync: true });
      // handled without state: our superseded op or a duplicate ack → drop
    } else if (msg.kind === 'playback') {
      this.onPlayback(msg.playback);
    } else if (msg.kind === 'playlist') {
      this.update({ playlist: msg.media });
    } else if (msg.kind === 'settings') {
      if (msg.autoPlay !== this.snap.autoPlay) this.update({ autoPlay: msg.autoPlay });
      const tv = this.snap.tvSubtitles;
      if (!tv || tv.enabled !== msg.tvSubtitles.enabled || tv.track !== msg.tvSubtitles.track) {
        this.update({ tvSubtitles: msg.tvSubtitles });
      }
    } else if (msg.kind === 'members') {
      this.update({ memberChanges: this.snap.memberChanges + 1 });
    } else if (msg.kind === 'gate') {
      const waitingDevices = msg.holding ? msg.waitingDevices : 0;
      if (waitingDevices !== this.snap.waitingDevices) this.update({ waitingDevices });
    } else if (msg.kind === 'error') {
      if (msg.opId) {
        const r = this.ops.reject(msg.opId);
        if (r.state) void this.apply(r.state, { forceSeek: true });
      }
      if (msg.code !== CONFLICT_CODE) this.update({ error: msg.message });
    } else if (msg.kind === 'termination') {
      if (terminationLosesAccess(msg.code)) this.loseAccess(msg.message || 'You no longer have access to this room.');
      else if (msg.message) this.update({ error: msg.message });
    }
  }

  // ---------------- app lifecycle (phones) ----------------

  private readonly onVisibility = (): void => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') {
      this.hiddenAt = Date.now();
      this.caughtUp = false;
      this.reportStatus(false);
      return;
    }
    const away = this.hiddenAt ? Date.now() - this.hiddenAt : 0;
    this.hiddenAt = 0;
    this.resume(away >= BACKGROUND_RECONNECT_MS);
  };

  private readonly onOnline = (): void => this.resume(false);

  /** Back in the foreground / online: reconnect now instead of waiting out the backoff. */
  private resume(forceReconnect: boolean): void {
    if (this.disposed || this.lost) return;
    void this.clock.sample();
    const open = !!this.ws && this.ws.readyState === 1;
    if (open && !forceReconnect) {
      if (this.cur) void this.performSync(this.cur);
      return;
    }
    this.attempts = 0;
    void this.openSocket();
  }

  private bindLifecycle(on: boolean): void {
    if (on === this.lifecycleBound || typeof document === 'undefined' || typeof window === 'undefined') return;
    this.lifecycleBound = on;
    const method = on ? 'addEventListener' : 'removeEventListener';
    document[method]('visibilitychange', this.onVisibility);
    window[method]('online', this.onOnline);
    window[method]('pageshow', this.onVisibility);
  }

  // ---------------- connection (spec §1) ----------------

  private async openSocket(): Promise<void> {
    if (this.disposed || this.lost) return;
    const gen = ++this.connectGen;
    this.clearReconnect();
    this.closeSocket();
    this.update({ connection: this.attempts > 0 ? 'reconnecting' : 'connecting' });
    let ticket: string;
    try {
      // A fresh single-use ticket on every (re)connect; 401s refresh via ApiClient.
      const res = await withTimeout(
        this.api.request<{ ticket?: string }>('POST', '/api/tickets', { roomId: this.roomId }),
        CONNECT_TIMEOUT_MS,
      );
      if (!res.ticket) throw new Error('no ticket');
      ticket = res.ticket;
    } catch (error) {
      if (gen !== this.connectGen) return;
      // 403: not a member any more (e.g. TV unpaired); 404: room gone. 401 here
      // means the refresh already failed and the client signed out.
      if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) {
        this.loseAccess(error.message);
        return;
      }
      this.scheduleReconnect();
      return;
    }
    if (this.disposed || gen !== this.connectGen) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl(this.origin, this.roomId, ticket));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.connectTimer = setTimeout(() => {
      if (this.ws === ws && ws.readyState !== 1) ws.close();
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.clearConnectTimer();
      this.attempts = 0;
      this.caughtUp = false;
      this.lastStatus = '';
      this.update({ connection: 'open', waitingDevices: 0 });
      // Same observation list on every connect → fresh full snapshots.
      for (const m of observeMessages(buildClientProfile(), { roomSettings: this.observesRoomSettings, roomDetails: this.observesRoomDetails })) this.send(m);
      this.heartbeatTimer = setInterval(() => this.send(heartbeatMessage(this.clock.now())), HEARTBEAT_MS);
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      if (typeof event.data === 'string') this.onMessage(event.data); // JSON mode: text frames only
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows; nothing else to do.
    };
  }

  private loseAccess(message: string): void {
    if (this.snap.accessLost) return;
    this.lost = true;
    this.clearReconnect();
    this.closeSocket();
    this.update({ accessLost: message, connection: 'closed' });
  }

  private send(message: unknown): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) {
      this.scheduleReconnect();
      return false;
    }
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch {
      this.scheduleReconnect();
      return false;
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.lost || this.reconnectTimer !== null) return;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    const next = nextReconnect(this.attempts);
    this.attempts = next.attempts;
    this.update({ connection: 'reconnecting' });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket();
    }, next.delayMs);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private clearTimers(): void {
    this.clearConnectTimer();
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = null;
    this.clearTimers();
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    if (this.disposed) this.update({ connection: 'closed' });
  }

  private update(patch: Partial<SyncSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const listener of this.listeners.slice()) listener(this.snap);
  }
}
