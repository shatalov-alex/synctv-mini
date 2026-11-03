// Thin wrapper around <video>: source loading (native, or lazily loaded hls.js
// when the browser lacks native HLS), a small control surface, and events
// tagged with whether *we* caused them. It knows nothing about rooms or sync.
import { EchoGuard, type EchoKind } from './echo';
import type { PlayableSource } from './source';

type HlsInstance = {
  loadSource(url: string): void;
  attachMedia(el: HTMLMediaElement): void;
  destroy(): void;
  on(event: string, cb: (event: string, data: { fatal?: boolean; type?: string; details?: string }) => void): void;
  recoverMediaError(): void;
  startLoad(): void;
};

export type PlayerEventType =
  | 'play'
  | 'pause'
  | 'seeking'
  | 'seeked'
  | 'ratechange'
  | 'waiting'
  | 'playing'
  | 'canplay'
  | 'timeupdate'
  | 'durationchange'
  | 'loadedmetadata'
  | 'ended'
  | 'error'
  /** play() was refused by autoplay policy even muted; needs a user gesture. */
  | 'autoplayblocked'
  /** play() only succeeded after muting; UI should offer "unmute". */
  | 'mutedautoplay';

export interface PlayerEvent {
  type: PlayerEventType;
  /**
   * false: caused by a programmatic call on this wrapper (an echo; a sync loop
   * should ignore it). true: from native controls, the OS (e.g. backgrounding),
   * or the media pipeline itself (stalls, hls.js gap nudges).
   */
  external: boolean;
  currentTime: number;
  message?: string;
}

export type PlayerListener = (event: PlayerEvent) => void;

const ECHO_EVENTS: Partial<Record<PlayerEventType, EchoKind>> = {
  play: 'play',
  pause: 'pause',
  seeking: 'seek',
  ratechange: 'rate',
};

const FORWARDED: PlayerEventType[] = [
  'play',
  'pause',
  'seeking',
  'seeked',
  'ratechange',
  'waiting',
  'playing',
  'canplay',
  'timeupdate',
  'durationchange',
  'loadedmetadata',
  'ended',
  'error',
];

export function nativeHlsSupported(video: HTMLVideoElement): boolean {
  return !!video.canPlayType && video.canPlayType('application/vnd.apple.mpegurl') !== '';
}

/**
 * Native HLS only on Apple's WebKit (Safari, Telegram for iOS/macOS), where it
 * is the best engine. Android WebViews (Telegram for Android) and newer Chrome
 * also claim native HLS, but their player seeks coarsely and may ignore
 * playbackRate, which breaks sync; hls.js over MSE behaves the same everywhere.
 */
export function preferNativeHls(video: HTMLVideoElement, env: { vendor: string; hasMse: boolean }): boolean {
  if (!nativeHlsSupported(video)) return false;
  return /apple/i.test(env.vendor) || !env.hasMse;
}

function hlsEnv(): { vendor: string; hasMse: boolean } {
  return { vendor: navigator.vendor || '', hasMse: 'MediaSource' in window || 'ManagedMediaSource' in window };
}

export class VideoPlayer {
  private readonly echo = new EchoGuard();
  private listeners: PlayerListener[] = [];
  private hls: HlsInstance | null = null;
  private source: PlayableSource | null = null;
  private waiting = false;
  private loadToken = 0;
  private triedHlsFallback = false;
  private readonly handlers: Array<[string, EventListener]> = [];

  constructor(readonly video: HTMLVideoElement) {
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.preload = 'auto';
    for (const type of FORWARDED) {
      const handler = () => this.onNative(type);
      video.addEventListener(type, handler);
      this.handlers.push([type, handler]);
    }
  }

  // ---- state a sync loop reads ----

  get currentTime(): number {
    return this.video.currentTime || 0;
  }
  get duration(): number {
    const d = this.video.duration;
    return isFinite(d) ? d : 0;
  }
  get paused(): boolean {
    return this.video.paused;
  }
  get playbackRate(): number {
    return this.video.playbackRate || 1;
  }
  /** Stalled waiting for data while supposed to be playing. */
  get buffering(): boolean {
    return this.waiting || (!this.video.paused && this.video.readyState < 3);
  }
  get ready(): boolean {
    return this.video.readyState >= 1;
  }
  get muted(): boolean {
    return this.video.muted;
  }
  get currentSource(): PlayableSource | null {
    return this.source;
  }

  on(listener: PlayerListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  // ---- programmatic controls (their events arrive with external=false) ----

  /** Starts playback; resolves false when the browser requires a user gesture. */
  async play(): Promise<boolean> {
    if (!this.video.paused) return true;
    this.echo.expect('play');
    try {
      await this.video.play();
      return true;
    } catch (error) {
      this.echo.cancel('play');
      if (!isNotAllowed(error)) return false;
    }
    // Autoplay policy: retry muted so the room keeps playing in sync.
    if (!this.video.muted) {
      this.video.muted = true;
      this.echo.expect('play');
      try {
        await this.video.play();
        this.emit('mutedautoplay', false);
        return true;
      } catch {
        this.echo.cancel('play');
      }
    }
    this.emit('autoplayblocked', false);
    return false;
  }

  pause(): void {
    if (this.video.paused) return;
    this.echo.expect('pause');
    this.video.pause();
  }

  seek(seconds: number): void {
    const target = Math.max(0, this.duration ? Math.min(seconds, this.duration - 0.1) : seconds);
    if (Math.abs(target - this.currentTime) < 0.01) return;
    this.echo.expect('seek');
    this.video.currentTime = target;
  }

  setRate(rate: number): void {
    if (Math.abs(this.video.playbackRate - rate) < 0.001) return;
    this.echo.expect('rate');
    this.video.playbackRate = rate;
  }

  setMuted(muted: boolean): void {
    this.video.muted = muted;
  }

  /** Runs fn with every resulting element event reported as programmatic. */
  programmatic(kinds: EchoKind[], fn: () => void): void {
    for (const kind of kinds) this.echo.expect(kind);
    fn();
  }

  // ---- source ----

  async load(source: PlayableSource | null): Promise<void> {
    const token = ++this.loadToken;
    this.teardownHls();
    this.echo.clear();
    this.waiting = false;
    this.source = source;
    this.triedHlsFallback = false;
    if (!source) {
      this.video.removeAttribute('src');
      this.video.load();
      return;
    }
    if (source.kind === 'hls' && !preferNativeHls(this.video, hlsEnv())) {
      await this.attachHls(source.url, token);
      return;
    }
    this.video.src = source.url;
    this.video.load();
  }

  destroy(): void {
    this.loadToken++;
    this.teardownHls();
    for (const [type, handler] of this.handlers) this.video.removeEventListener(type, handler);
    this.listeners = [];
    this.video.removeAttribute('src');
    this.video.load();
  }

  private async attachHls(url: string, token: number): Promise<void> {
    const mod = await import('hls.js/light');
    if (token !== this.loadToken) return;
    const Hls = mod.default;
    if (!Hls.isSupported()) {
      // Last resort: let the element try.
      this.video.src = url;
      this.video.load();
      return;
    }
    const hls = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 30 }) as unknown as HlsInstance;
    this.hls = hls;
    let mediaRecoveries = 0;
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 2) {
        hls.recoverMediaError();
      } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR && mediaRecoveries++ < 3) {
        hls.startLoad();
      } else if (token === this.loadToken && this.tryNativeHls(url)) {
        // hls.js never got going (often a stream without CORS headers, which
        // only MSE needs): let the element's own HLS player try instead.
      } else {
        this.emit('error', true, data.details || 'HLS playback error');
      }
    });
    hls.attachMedia(this.video);
    hls.loadSource(url);
  }

  private tryNativeHls(url: string): boolean {
    if (this.triedHlsFallback || this.video.readyState > 0 || !nativeHlsSupported(this.video)) return false;
    this.triedHlsFallback = true;
    this.teardownHls();
    this.video.src = url;
    this.video.load();
    return true;
  }

  private teardownHls(): void {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
  }

  private onNative(type: PlayerEventType): void {
    if (type === 'waiting') this.waiting = true;
    else if (type === 'playing' || type === 'canplay' || type === 'seeked' || type === 'pause') this.waiting = false;

    if (type === 'error') {
      // Native HLS claimed support but failed before metadata: try hls.js once.
      const source = this.source;
      if (source && source.kind === 'hls' && !this.hls && !this.triedHlsFallback && this.video.readyState === 0) {
        this.triedHlsFallback = true;
        void this.attachHls(source.url, this.loadToken);
        return;
      }
      const err = this.video.error;
      this.emit('error', true, err ? mediaErrorMessage(err.code) : 'Playback error');
      return;
    }
    const kind = ECHO_EVENTS[type];
    const external = kind ? !this.echo.consume(kind) : true;
    this.emit(type, external);
  }

  private emit(type: PlayerEventType, external: boolean, message?: string): void {
    const event: PlayerEvent = { type, external, currentTime: this.currentTime, message };
    for (const listener of this.listeners.slice()) listener(event);
  }
}

function isNotAllowed(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: string }).name === 'NotAllowedError';
}

function mediaErrorMessage(code: number): string {
  switch (code) {
    case 1:
      return 'Playback aborted';
    case 2:
      return 'Network error while loading the video';
    case 3:
      return 'The video could not be decoded';
    case 4:
      return 'This video format or URL is not supported here';
    default:
      return 'Playback error';
  }
}
