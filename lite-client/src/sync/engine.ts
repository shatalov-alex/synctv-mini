// Room sync engine: a port of the official SyncTV client's playback sync
// (room_screen.dart). See README "Sync" for the behaviour and deviations.
//
// Invariants (spec §5.1/§5.3): only UI gestures send commands; player events
// never do. Our own echoes are stored but not re-applied to the player.
import { ApiError, type ApiClient } from '../api/http';
import { playNext, playPrevious } from '../api/endpoints';
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
} from './protocol';
import {
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
} from './state';
import type { SyncEngine, SyncSnapshot } from './types';

const INIT_TIMEOUT_MS = 20_000;
/**
 * Hidden longer than this (Telegram minimised, phone locked): the socket may
 * be a zombie that still reports OPEN, so reconnect on return. A reconnect is
 * cheap: observing re-sends the full state.
 */
export const BACKGROUND_RECONNECT_MS = 15_000;
const MAX_ERROR_RELOADS = 3;
/** "Completed" tolerance for play-from-end (custom_video_player.dart:1769). */
const ENDED_TOLERANCE_S = 0.5;

interface Resolved {
  mediaId: string;
  playlistId: string;
  source: PlayableSource | null;
  live: boolean;
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
  };

  // sync state
  private cur: SyncState | null = null;
  private resolved: Resolved | null = null;
  private loadedKey: string | null = null;
  private loadedReady = false;
  private errorReloads = 0;
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
  private readonly unsubscribePlayer: () => void;
  private hiddenAt = 0;
  /** Bumped per openSocket so an older, slower ticket request can't open a second socket. */
  private connectGen = 0;
  private lifecycleBound = false;

  constructor(
    private readonly api: ApiClient,
    private readonly player: VideoPlayer,
    options: RoomSyncEngineOptions = {},
  ) {
    this.origin = options.origin || location.origin;
    this.freeMode = !!options.freeMode;
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

  dispose(): void {
    this.disposed = true;
    this.bindLifecycle(false);
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
    const sourceChanged = !!this.cur && !sameSource(this.cur, s);
    this.cur = s;
    if (!hasSource(s)) {
      this.unload();
      this.update({ state: s, source: null, live: false });
      return;
    }
    const res = this.resolvedFor(s);
    this.update({ state: s, source: res ? res.source : null, live: res ? res.live : false });
    if (!res || !res.source) return; // wait for the `playback` resource
    const needLoad = res.source.key !== this.loadedKey;
    if (opts.skipPlayerSync && !needLoad) return;
    if (needLoad) {
      await this.load(res.source);
      return;
    }
    await this.performSync(s, !!opts.forceSeek || sourceChanged);
  }

  /** `playback` resource: player-ready source, no timing (merge keeps current timing). */
  private onPlayback(playback: Playback): void {
    this.resolved = {
      mediaId: playback.mediaId || '',
      playlistId: playback.playlistId || '',
      source: pickSource(playback),
      live: isLivePlayback(playback),
    };
    if (this.resolved.mediaId && !this.resolved.source) {
      this.update({ error: 'This media has no source this player can open (needs HLS or a direct video file).' });
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
    this.loadedKey = source.key;
    this.loadedReady = false;
    if (source.requiresHeaders) {
      this.update({ error: 'This source needs custom request headers, which browsers cannot send to <video>.' });
    }
    await this.player.load(source);
    const ready = await this.waitForMetadata(gen);
    if (gen !== this.loadGen || this.disposed) return;
    if (!ready) return; // init timeout; the error path or a later event retries
    this.loadedReady = true;
    if (this.cur) await this.performSync(this.cur, true); // initial join / media change: forced
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
      if (plan.seek !== null) this.player.seek(plan.seek);
      if (!isCurrent()) return;
      if (plan.play) await this.player.play(); // muted autoplay fallback lives in the player
    } finally {
      setTimeout(() => {
        if (gen === this.syncGen) this.syncing = false;
      }, SYNC_COOLDOWN_MS);
    }
  }

  private retryLoop(): void {
    if (this.syncing || this.freeMode || !this.cur || !this.loadedReady || !this.player.ready) return;
    if (!this.resolvedFor(this.cur)) return;
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

  private onPlayerError(message: string): void {
    const source = this.player.currentSource;
    if (source && this.errorReloads < MAX_ERROR_RELOADS) {
      this.errorReloads++;
      void this.load(source); // reload, then forced sync once ready
      return;
    }
    this.update({ error: message });
  }

  // ---------------- local gestures (spec §5) ----------------

  private userAction(kind: UpdateKind, arg?: number): void {
    const cur = this.cur;
    if (!cur || !this.loadedReady || !this.player.ready) return;
    const live = this.snap.live;
    if (live && kind === 'seek') return;
    this.restoreAudio();
    this.errorReloads = 0;
    const duration = this.player.duration;
    const clamp = (t: number) => Math.max(0, duration > 0 ? Math.min(t, duration) : t);

    // 1) apply locally first
    let playing = cur.playing;
    if (kind === 'play') {
      if (duration > 0 && this.player.currentTime >= duration - ENDED_TOLERANCE_S) this.player.seek(0);
      void this.player.play();
      playing = true;
    } else if (kind === 'pause') {
      this.player.pause();
      playing = false;
    } else if (kind === 'seek') {
      this.player.seek(clamp(arg || 0));
      // restore the expected play state after the seek
      if (cur.playing && this.player.paused) void this.player.play();
      else if (!cur.playing && !this.player.paused) this.player.pause();
    } else if (kind === 'speed' && arg) {
      this.player.setRate(arg);
    }

    // 2) command
    const opId = uuidv4();
    const t = Math.round(this.clock.now());
    const position = clamp(kind === 'seek' ? arg || 0 : this.player.currentTime);
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
      speed: kind === 'speed' && arg ? arg : this.player.playbackRate,
      generatedAtMs: t,
      opId,
    };
    this.cur = optimistic;
    this.update({ state: optimistic, error: null });
    if (!this.send(message)) {
      const r = this.ops.reject(opId);
      if (r.state) void this.apply(r.state, { forceSeek: true });
    }
  }

  private async navigate(call: (api: ApiClient, roomId: string) => Promise<unknown>): Promise<void> {
    if (this.snap.navigating || !this.roomId) return;
    this.update({ navigating: true });
    try {
      await call(this.api, this.roomId); // response ignored: state arrives over the socket
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
      this.update({ connection: 'open' });
      // Same observation list on every connect → fresh full snapshots.
      for (const m of observeMessages(buildClientProfile())) this.send(m);
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
