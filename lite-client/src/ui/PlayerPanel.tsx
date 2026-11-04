import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { formatTime } from '../format';
import { haptic, onTgFullscreenChange, setTgFullscreen, tgFullscreenSupported } from '../telegram';
import type { PlayerBinding } from './usePlayer';
import { usePlayerTick, useTicker } from './usePlayer';

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
export const SEEK_STEP_S = 10;
const CONTROLS_IDLE_MS = 3500;

const CONNECTION_LABEL: Record<string, string> = {
  idle: '',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  open: '',
  closed: 'Disconnected',
};

type FsDocument = Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => void };

function nativeFullscreenElement(): Element | null {
  const doc = document as FsDocument;
  return doc.fullscreenElement || doc.webkitFullscreenElement || null;
}

/**
 * Fullscreen that keeps our own controls (the room's sync depends on them):
 * Telegram's fullscreen (Bot API 8.0) or the element Fullscreen API, both
 * with the player laid out over the whole viewport. iPhones have neither, so
 * there it is the CSS layout alone; we never hand the video to iOS's native
 * player, whose controls would bypass the room.
 */
function useFullscreen(container: HTMLElement | null) {
  const [on, setOn] = useState(false);

  useEffect(() => {
    const onNative = () => {
      if (!nativeFullscreenElement()) setOn(false);
    };
    document.addEventListener('fullscreenchange', onNative);
    document.addEventListener('webkitfullscreenchange', onNative);
    const offTg = onTgFullscreenChange((fs) => {
      if (!fs) setOn(false);
    });
    return () => {
      document.removeEventListener('fullscreenchange', onNative);
      document.removeEventListener('webkitfullscreenchange', onNative);
      offTg();
    };
  }, []);

  // Layout effect: lock page scroll in the same frame the player goes fullscreen.
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('player-max', on);
    return () => document.documentElement.classList.remove('player-max');
  }, [on]);

  // Leave Telegram fullscreen when the player goes away (e.g. back to rooms).
  useEffect(() => () => setTgFullscreen(false), []);

  const toggle = () => {
    const next = !on;
    setOn(next);
    if (tgFullscreenSupported()) {
      setTgFullscreen(next);
      return;
    }
    const doc = document as FsDocument;
    if (!next) {
      if (nativeFullscreenElement()) {
        if (document.exitFullscreen) void document.exitFullscreen().catch(() => undefined);
        else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
      }
      return;
    }
    const el = container as FsElement | null;
    if (el && el.requestFullscreen) void el.requestFullscreen().catch(() => undefined);
    else if (el && el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  };

  return { on, toggle };
}

function waitingText(devices: number): string {
  return `Waiting for ${devices} ${devices === 1 ? 'device' : 'devices'} to load the video…`;
}

export function PlayerPanel({
  binding,
  compact,
  canUseRemote,
  onRemoteChange,
}: {
  binding: PlayerBinding;
  compact?: boolean;
  /** A TV is paired to the room; without one a phone has nothing to be the remote of. */
  canUseRemote: boolean;
  /** Remote mode switched by the viewer (to remember it for the room). */
  onRemoteChange?: (on: boolean) => void;
}) {
  const { videoRef, engine, player, snapshot } = binding;
  usePlayerTick(player);
  const [drag, setDrag] = useState<number | null>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const fullscreen = useFullscreen(container);
  const [idle, setIdle] = useState(false);
  const [wake, setWake] = useState(0);

  const remote = !!(snapshot && snapshot.remote);
  useTicker(remote);
  const hasMedia = !!(snapshot && snapshot.source);
  const live = !!(snapshot && snapshot.live);
  const duration = player ? player.duration : 0;
  const position = engine ? engine.position() : 0;
  const current = drag !== null ? drag : position;
  // Remote mode: show the room's state; nothing plays here.
  const paused = remote ? !(snapshot && snapshot.state && snapshot.state.playing) : player ? player.paused : true;
  const rate = snapshot && snapshot.state ? snapshot.state.speed : 1;
  const status = snapshot ? CONNECTION_LABEL[snapshot.connection] : '';
  const act = (fn: () => void) => () => {
    haptic();
    fn();
  };

  // In fullscreen the controls float over the video and fade out while playing.
  useEffect(() => {
    setIdle(false);
    if (!fullscreen.on || paused) return;
    const timer = setTimeout(() => setIdle(true), CONTROLS_IDLE_MS);
    return () => clearTimeout(timer);
  }, [fullscreen.on, paused, wake]);
  const poke = () => setWake((n) => n + 1);
  const toggleRemote = () => {
    if (!engine) return;
    haptic();
    if (fullscreen.on) fullscreen.toggle();
    engine.setRemote(!remote);
    if (onRemoteChange) onRemoteChange(!remote);
  };
  const onStageTap = () => {
    if (!fullscreen.on) return;
    if (idle) poke();
    else setIdle(true);
  };

  return (
    <div class={fullscreen.on ? (idle ? 'player max idle' : 'player max') : 'player'} ref={setContainer}>
      <div class="player-stage" onClick={onStageTap}>
        <video ref={videoRef} class="video" playsInline />
        {remote && (
          <div class="player-remote">
            <div class="player-remote-icon">📺</div>
            <div>{hasMedia ? 'Playing on TV' : 'Remote mode'}</div>
            <div class="small">This phone is the remote</div>
          </div>
        )}
        {!hasMedia && !remote && (
          <div class="player-empty">
            {snapshot && snapshot.state && snapshot.state.mediaId ? 'Loading…' : 'Nothing is playing'}
          </div>
        )}
        {snapshot && snapshot.needsGesture && engine && !remote && (
          <button class="player-unlock" onClick={() => engine.unlock()}>
            Tap to start
          </button>
        )}
        {snapshot && snapshot.autoMuted && engine && !remote && (
          <button class="player-unmute" onClick={() => engine.unlock()}>
            🔇 Tap to unmute
          </button>
        )}
        {status && <div class="player-status">{status}</div>}
      </div>
      <div class="controls" onPointerDown={poke}>
        {!live && (
          <input
            class="seek"
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={current}
            disabled={!hasMedia || !duration}
            onInput={(e) => setDrag(Number((e.target as HTMLInputElement).value))}
            onChange={(e) => {
              // Commit on release only (official client: slider onChangeEnd).
              const value = Number((e.target as HTMLInputElement).value);
              setDrag(null);
              if (engine) engine.seek(value);
            }}
          />
        )}
        <div class="controls-row">
          <span class="time">
            {formatTime(current)}
            {!live && duration ? ` / ${formatTime(duration)}` : live ? ' · LIVE' : ''}
          </span>
          <span class="spacer" />
          <select
            class="speed"
            value={String(rate)}
            disabled={!hasMedia}
            onChange={(e) => engine && engine.setRate(Number((e.target as HTMLSelectElement).value))}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={String(s)}>
                {s}×
              </option>
            ))}
          </select>
        </div>
        <div class="controls-row buttons">
          <button disabled={!engine || (snapshot ? snapshot.navigating : true)} onClick={act(() => engine && void engine.prev())} aria-label="Previous">
            ⏮
          </button>
          {!live && (
            <button disabled={!hasMedia} onClick={act(() => engine && engine.seek(engine.position() - SEEK_STEP_S))} aria-label="Back 10 seconds">
              −10
            </button>
          )}
          <button class="primary" disabled={!hasMedia} onClick={act(() => engine && (paused ? engine.play() : engine.pause()))} aria-label={paused ? 'Play' : 'Pause'}>
            {paused ? '▶' : '⏸'}
          </button>
          {!live && (
            <button disabled={!hasMedia} onClick={act(() => engine && engine.seek(engine.position() + SEEK_STEP_S))} aria-label="Forward 10 seconds">
              +10
            </button>
          )}
          <button disabled={!engine || (snapshot ? snapshot.navigating : true)} onClick={act(() => engine && void engine.next())} aria-label="Next">
            ⏭
          </button>
        </div>
        {(!compact || fullscreen.on) && (
          <div class="controls-row buttons secondary">
            {!remote && (
              <button disabled={!hasMedia} onClick={() => engine && engine.syncNow()}>
                Sync
              </button>
            )}
            {!remote && (
              <button disabled={!hasMedia && !fullscreen.on} onClick={fullscreen.toggle}>
                {fullscreen.on ? 'Exit fullscreen' : 'Fullscreen'}
              </button>
            )}
            <button disabled={!engine || (!remote && !canUseRemote)} onClick={toggleRemote}>
              {remote ? 'Watch on this phone' : 'Use as remote'}
            </button>
          </div>
        )}
        {snapshot && snapshot.waitingDevices > 0 && <div class="small">{waitingText(snapshot.waitingDevices)}</div>}
        {snapshot && snapshot.error && <div class="error small">{snapshot.error}</div>}
      </div>
    </div>
  );
}
