import { useEffect, useState } from 'preact/hooks';
import type { ApiClient } from '../api/http';
import {
  claimErrorMessage,
  claimPairing,
  listTvDevices,
  normalizeCode,
  revokeTvDevice,
  type TvDevice,
} from '../api/tv';
import { errorMessage } from '../format';

function pairedAgo(pairedAtSec: number, nowMs: number): string {
  if (!pairedAtSec) return '';
  const minutes = Math.floor((nowMs / 1000 - pairedAtSec) / 60);
  if (minutes < 1) return 'paired just now';
  if (minutes < 60) return `paired ${minutes} min ago`;
  if (minutes < 48 * 60) return `paired ${Math.floor(minutes / 60)} h ago`;
  return `paired ${Math.floor(minutes / 1440)} d ago`;
}

export function CodeInput(props: { value: string; onInput: (value: string) => void }) {
  return (
    <input
      class="code-input"
      type="text"
      autoComplete="off"
      autoCapitalize="characters"
      spellcheck={false}
      placeholder="CODE"
      maxLength={16}
      value={props.value}
      onInput={(e) => props.onInput((e.target as HTMLInputElement).value.toUpperCase())}
    />
  );
}

/** "Watch on TV": claim the code shown on /tv; the creator also manages paired TVs. */
export function PairTvPanel({ api, roomId, isCreator }: { api: ApiClient; roomId: string; isCreator: boolean }) {
  const [code, setCode] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState('');
  const [tvs, setTvs] = useState<TvDevice[]>([]);

  const reloadTvs = () => {
    if (!isCreator) return Promise.resolve();
    return listTvDevices(api, roomId).then(setTvs, (e) => setError(errorMessage(e)));
  };
  useEffect(() => {
    void reloadTvs();
  }, [roomId, isCreator]);

  const submit = async (event: Event) => {
    event.preventDefault();
    const normalized = normalizeCode(code);
    if (!normalized) return;
    setState('busy');
    setError('');
    try {
      await claimPairing(api, normalized, roomId);
      setState('done');
      setCode('');
      void reloadTvs();
    } catch (e) {
      setState('idle');
      setError(claimErrorMessage(e));
    }
  };

  const unpair = async (tv: TvDevice) => {
    if (!confirm(`Unpair “${tv.name}”? It will go back to the pairing screen.`)) return;
    try {
      await revokeTvDevice(api, roomId, tv.userId);
      await reloadTvs();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const now = Date.now();
  return (
    <section class="card">
      <h2>Watch on TV</h2>
      <p class="muted small">
        Open <b>{location.host}/tv</b> on the TV and enter the code it shows (or scan its QR code).
      </p>
      <form class="row" onSubmit={submit}>
        <CodeInput
          value={code}
          onInput={(value) => {
            setCode(value);
            setState('idle');
          }}
        />
        <button type="submit" class="primary" disabled={state === 'busy' || !code}>
          Pair
        </button>
      </form>
      {state === 'done' && <p class="ok">TV paired ✓ It will start playing in a moment.</p>}
      {isCreator && tvs.length > 0 && (
        <ul class="list">
          {tvs.map((tv) => (
            <li key={tv.userId}>
              <span class="grow">
                📺 {tv.name} <span class="muted small">{pairedAgo(tv.pairedAt, now)}</span>
              </span>
              <button class="ghost danger" onClick={() => unpair(tv)}>
                Unpair
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p class="error">{error}</p>}
    </section>
  );
}
