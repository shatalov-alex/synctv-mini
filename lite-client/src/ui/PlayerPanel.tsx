import { useState } from 'preact/hooks';
import { formatTime } from '../format';
import { haptic } from '../telegram';
import type { PlayerBinding } from './usePlayer';
import { usePlayerTick } from './usePlayer';

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
export const SEEK_STEP_S = 10;

const CONNECTION_LABEL: Record<string, string> = {
  idle: '',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  open: '',
  closed: 'Disconnected',
};

function requestFullscreen(container: HTMLElement | null, video: HTMLVideoElement | null): void {
  const el = container as (HTMLElement & { webkitRequestFullscreen?: () => void }) | null;
  const v = video as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
  const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
  if (doc.fullscreenElement || doc.webkitFullscreenElement) {
    if (document.exitFullscreen) void document.exitFullscreen();
    else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
    return;
  }
  if (el && el.requestFullscreen) void el.requestFullscreen().catch(() => undefined);
  else if (el && el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  else if (v && v.webkitEnterFullscreen) v.webkitEnterFullscreen(); // iOS Safari
}

export function PlayerPanel({ binding, compact }: { binding: PlayerBinding; compact?: boolean }) {
  const { videoRef, engine, player, snapshot } = binding;
  usePlayerTick(player);
  const [drag, setDrag] = useState<number | null>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);

  const hasMedia = !!(snapshot && snapshot.source);
  const live = !!(snapshot && snapshot.live);
  const duration = player ? player.duration : 0;
  const current = drag !== null ? drag : player ? player.currentTime : 0;
  const paused = player ? player.paused : true;
  const rate = snapshot && snapshot.state ? snapshot.state.speed : 1;
  const status = snapshot ? CONNECTION_LABEL[snapshot.connection] : '';
  const act = (fn: () => void) => () => {
    haptic();
    fn();
  };

  return (
    <div class="player" ref={setContainer}>
      <div class="player-stage">
        <video ref={videoRef} class="video" playsInline />
        {!hasMedia && (
          <div class="player-empty">
            {snapshot && snapshot.state && snapshot.state.mediaId ? 'Loading…' : 'Nothing is playing'}
          </div>
        )}
        {snapshot && snapshot.needsGesture && engine && (
          <button class="player-unlock" onClick={() => engine.unlock()}>
            Tap to start
          </button>
        )}
        {snapshot && snapshot.autoMuted && engine && (
          <button class="player-unmute" onClick={() => engine.unlock()}>
            🔇 Tap to unmute
          </button>
        )}
        {status && <div class="player-status">{status}</div>}
      </div>
      <div class="controls">
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
            <button disabled={!hasMedia} onClick={act(() => engine && player && engine.seek(player.currentTime - SEEK_STEP_S))} aria-label="Back 10 seconds">
              −10
            </button>
          )}
          <button class="primary" disabled={!hasMedia} onClick={act(() => engine && (paused ? engine.play() : engine.pause()))} aria-label={paused ? 'Play' : 'Pause'}>
            {paused ? '▶' : '⏸'}
          </button>
          {!live && (
            <button disabled={!hasMedia} onClick={act(() => engine && player && engine.seek(player.currentTime + SEEK_STEP_S))} aria-label="Forward 10 seconds">
              +10
            </button>
          )}
          <button disabled={!engine || (snapshot ? snapshot.navigating : true)} onClick={act(() => engine && void engine.next())} aria-label="Next">
            ⏭
          </button>
        </div>
        {!compact && (
          <div class="controls-row buttons secondary">
            <button disabled={!hasMedia} onClick={() => engine && engine.syncNow()}>
              Sync
            </button>
            <button disabled={!hasMedia} onClick={() => requestFullscreen(container, videoRef.current)}>
              Fullscreen
            </button>
          </div>
        )}
        {snapshot && snapshot.error && <div class="error small">{snapshot.error}</div>}
      </div>
    </div>
  );
}
