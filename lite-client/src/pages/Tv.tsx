// /tv — full-screen player for smart-TV browsers. Pairs via a code/QR that a
// signed-in phone claims, then plays the room, driven by the remote.
import { useEffect, useRef, useState } from 'preact/hooks';
import { createApi } from '../auth';
import { ApiError } from '../api/http';
import { createPairing, pollPairing, pollRetryDelayMs, startRetryDelayMs, type TvPairing } from '../api/tv';
import { formatTime } from '../format';
import { pairLink } from '../links';
import { usePlayer, usePlayerTick } from '../ui/usePlayer';
import { tvAction } from './tvKeys';

const tvApi = createApi('synctv-lite.tv');
const ROOM_KEY = 'synctv-lite.tv.room';
const SEEK_STEP_S = 10;
const OVERLAY_MS = 4000;

function savedRoom(): string {
  try {
    return localStorage.getItem(ROOM_KEY) || '';
  } catch {
    return '';
  }
}

function saveRoom(roomId: string | null): void {
  try {
    if (roomId) localStorage.setItem(ROOM_KEY, roomId);
    else localStorage.removeItem(ROOM_KEY);
  } catch {
    // ignore
  }
}

export function Tv() {
  const [roomId, setRoomId] = useState(() => (tvApi.store.get() ? savedRoom() : ''));
  /** Why we are back on the pairing screen (unpaired from the phone, session ended). */
  const [notice, setNotice] = useState('');

  useEffect(() => {
    document.documentElement.classList.add('tv-mode');
    tvApi.schedule();
    // Refresh fails once the TV is unpaired: back to pairing.
    tvApi.setOnSignedOut(() => {
      saveRoom(null);
      setNotice('This TV was unpaired.');
      setRoomId('');
    });
    return () => document.documentElement.classList.remove('tv-mode');
  }, []);

  const unpair = (reason?: string) => {
    tvApi.signOut();
    saveRoom(null);
    setNotice(reason || '');
    setRoomId('');
  };

  if (!roomId) {
    return (
      <Pairing
        notice={notice}
        onPaired={(id) => {
          setNotice('');
          saveRoom(id);
          setRoomId(id);
        }}
      />
    );
  }
  return <Watch key={roomId} roomId={roomId} onUnpair={unpair} />;
}

function Pairing({ onPaired, notice }: { onPaired: (roomId: string) => void; notice: string }) {
  const [pairing, setPairing] = useState<TvPairing | null>(null);
  const [qr, setQr] = useState('');
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);

  // Create a pairing, then poll until claimed; start over when it expires.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const retry = (error: unknown) => {
      if (!stopped) timer = setTimeout(() => setGeneration((g) => g + 1), startRetryDelayMs(error));
    };
    createPairing(tvApi).then(
      (p) => {
        if (stopped) return;
        setPairing(p);
        setError('');
        const poll = () => {
          if (stopped) return;
          if (Date.now() > p.expiresAtMs) {
            setGeneration((g) => g + 1);
            return;
          }
          pollPairing(tvApi, p.pairingSecret).then(
            (result) => {
              if (stopped) return;
              if (result.status === 'claimed') {
                tvApi.signIn(result.tokens);
                onPaired(result.roomId);
              } else if (result.status === 'expired') {
                setGeneration((g) => g + 1);
              } else {
                timer = setTimeout(poll, p.pollIntervalMs);
              }
            },
            (error) => {
              if (!stopped) timer = setTimeout(poll, pollRetryDelayMs(error, p.pollIntervalMs));
            },
          );
        };
        timer = setTimeout(poll, p.pollIntervalMs);
      },
      (error) => {
        if (stopped) return;
        setError(
          error instanceof ApiError && error.status === 429
            ? 'Too many pairing attempts. Trying again in a minute…'
            : 'Cannot reach the server. Retrying…',
        );
        retry(error);
      },
    );
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [generation]);

  useEffect(() => {
    if (!pairing) return;
    let cancelled = false;
    const link = pairLink(pairing.code, location.origin);
    import('uqr').then(({ renderSVG }) => {
      if (cancelled) return;
      const svg = renderSVG(link, { border: 2, pixelSize: 8 });
      setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    });
    return () => {
      cancelled = true;
    };
  }, [pairing && pairing.code]);

  return (
    <main class="tv-pair">
      <h1>SyncTV</h1>
      {notice && <p class="tv-notice">{notice}</p>}
      {pairing ? (
        <div class="tv-pair-body">
          {qr && <img class="tv-qr" src={qr} alt="" width={280} height={280} />}
          <div>
            <p>Scan with your phone, or open the Mini App → room → “Watch on TV” and enter:</p>
            <div class="tv-code">{pairing.code}</div>
          </div>
        </div>
      ) : (
        <p>{error || 'Getting a pairing code…'}</p>
      )}
      {pairing && error && <p class="error">{error}</p>}
    </main>
  );
}

function Watch({ roomId, onUnpair }: { roomId: string; onUnpair: (reason?: string) => void }) {
  const binding = usePlayer(tvApi, roomId);
  const { engine, player, snapshot, videoRef } = binding;
  const accessLost = snapshot ? snapshot.accessLost : null;

  // Kicked / unpaired / no longer a member: drop the session and re-pair.
  useEffect(() => {
    if (accessLost) onUnpair('This TV was unpaired or lost access to the room.');
  }, [accessLost]);
  usePlayerTick(player);
  const [overlay, setOverlay] = useState(true);
  const overlayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unpairArmed = useRef(0);

  const showOverlay = () => {
    setOverlay(true);
    if (overlayTimer.current) clearTimeout(overlayTimer.current);
    overlayTimer.current = setTimeout(() => setOverlay(false), OVERLAY_MS);
  };

  useEffect(() => {
    showOverlay();
    return () => {
      if (overlayTimer.current) clearTimeout(overlayTimer.current);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = tvAction(event.key, event.keyCode);
      if (!action || !engine || !player) return;
      event.preventDefault();
      showOverlay();
      const snap = engine.snapshot();
      // First OK after a blocked/muted autoplay is the gesture that unlocks audio.
      if ((snap.needsGesture || snap.autoMuted) && (action === 'toggle' || action === 'play')) {
        engine.unlock();
        return;
      }
      switch (action) {
        case 'toggle':
          if (player.paused) engine.play();
          else engine.pause();
          break;
        case 'play':
          engine.play();
          break;
        case 'pause':
          engine.pause();
          break;
        case 'back10':
          engine.seek(player.currentTime - SEEK_STEP_S);
          break;
        case 'forward10':
          engine.seek(player.currentTime + SEEK_STEP_S);
          break;
        case 'next':
          void engine.next();
          break;
        case 'prev':
          void engine.prev();
          break;
        case 'unpair':
          // Press the red key twice within 3 s to unpair.
          if (Date.now() - unpairArmed.current < 3000) onUnpair();
          else unpairArmed.current = Date.now();
          break;
        default:
          break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [engine, player]);

  const duration = player ? player.duration : 0;
  const current = player ? player.currentTime : 0;
  const paused = player ? player.paused : true;
  const nothing = !snapshot || !snapshot.source;
  const armed = Date.now() - unpairArmed.current < 3000;

  return (
    <main class="tv-watch">
      <video ref={videoRef} class="tv-video" playsInline />
      {nothing && <div class="tv-center">Nothing is playing yet</div>}
      {snapshot && (snapshot.needsGesture || snapshot.autoMuted) && (
        <div class="tv-center small">Press OK to {snapshot.needsGesture ? 'start' : 'turn on sound'}</div>
      )}
      {(overlay || paused) && !nothing && (
        <div class="tv-overlay">
          <div class="tv-bar">
            <div class="tv-bar-fill" style={{ width: duration ? `${Math.min(100, (current / duration) * 100)}%` : '0%' }} />
          </div>
          <div class="tv-meta">
            <span>{paused ? '⏸' : '▶'}</span>
            <span>
              {formatTime(current)}
              {duration ? ` / ${formatTime(duration)}` : ''}
            </span>
            <span class="grow">{snapshot && snapshot.source ? snapshot.source.name : ''}</span>
            {snapshot && snapshot.connection !== 'open' && <span>{snapshot.connection === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</span>}
          </div>
          <div class="tv-hint">
            OK play/pause · ◀ ▶ ±10 s{armed ? ' · press red again to unpair' : ' · red twice: unpair'}
          </div>
        </div>
      )}
      {snapshot && snapshot.error && <div class="tv-error">{snapshot.error}</div>}
    </main>
  );
}
