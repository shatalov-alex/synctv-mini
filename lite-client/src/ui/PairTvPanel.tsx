import { useState } from 'preact/hooks';
import type { ApiClient } from '../api/http';
import { claimPairing, normalizeCode } from '../api/tv';
import { errorMessage } from '../format';

/** "Show this room on a TV": enter the code shown on the /tv page. */
export function PairTvPanel({ api, roomId, initialCode }: { api: ApiClient; roomId: string; initialCode?: string }) {
  const [code, setCode] = useState(initialCode || '');
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState('');

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
    } catch (e) {
      setState('idle');
      setError(errorMessage(e));
    }
  };

  return (
    <section class="card">
      <h2>Watch on TV</h2>
      <p class="muted small">
        Open <b>{location.host}/tv</b> on the TV and enter the code it shows (or scan its QR code).
      </p>
      <form class="row" onSubmit={submit}>
        <input
          class="code-input"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="Code"
          maxLength={12}
          value={code}
          onInput={(e) => {
            setCode((e.target as HTMLInputElement).value);
            setState('idle');
          }}
        />
        <button type="submit" class="primary" disabled={state === 'busy' || !code}>
          Pair
        </button>
      </form>
      {state === 'done' && <p class="ok">TV paired ✓ It will start playing in a moment.</p>}
      {error && <p class="error">{error}</p>}
    </section>
  );
}
