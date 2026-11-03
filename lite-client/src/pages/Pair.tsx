// /pair?code=XXXXXX — reached by scanning the TV's QR code (or a pair-<code>
// Mini App start_param). Pick one of your rooms and hand it to the TV.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../auth';
import { listMyRooms } from '../api/endpoints';
import { claimErrorMessage, claimPairing, normalizeCode } from '../api/tv';
import { CodeInput } from '../ui/PairTvPanel';
import type { MyRoom, User } from '../api/types';
import { errorMessage } from '../format';
import { navigate, roomPath } from '../router';
import { setRemoteModeFor } from '../remoteMode';
import { useBackButtonEffect } from '../telegram';

export function Pair({ code, me }: { code: string; me: User | null }) {
  const [rooms, setRooms] = useState<MyRoom[] | null>(null);
  const [selected, setSelected] = useState('');
  const [typed, setTyped] = useState(code);
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState('');

  useEffect(() => useBackButtonEffect(() => navigate('/')), []);
  useEffect(() => {
    if (!me) return;
    listMyRooms(api).then(
      (list) => {
        setRooms(list);
        if (list.length && list[0].room && list[0].room.id) setSelected(list[0].room.id);
      },
      (e) => setError(errorMessage(e)),
    );
  }, [me]);

  if (!me) {
    return (
      <main class="page">
        <h1>Pair a TV</h1>
        <p class="error">Sign in first: open the SyncTV Mini App in Telegram, then scan the code again.</p>
      </main>
    );
  }

  const claim = async (event: Event) => {
    event.preventDefault();
    const normalized = normalizeCode(typed);
    if (!normalized || !selected) return;
    setState('busy');
    setError('');
    try {
      await claimPairing(api, normalized, selected);
      setRemoteModeFor(selected, true); // the room opens here as the TV's remote
      setState('done');
    } catch (e) {
      setState('idle');
      setError(claimErrorMessage(e));
    }
  };

  return (
    <main class="page">
      <h1>Pair a TV</h1>
      {state === 'done' ? (
        <section class="card stack">
          <p class="ok">TV paired ✓</p>
          <button class="primary" onClick={() => navigate(roomPath(selected), true)}>
            Open the remote
          </button>
        </section>
      ) : (
        <form class="card stack" onSubmit={claim}>
          <label class="small muted">Code shown on the TV</label>
          <CodeInput value={typed} onInput={setTyped} />
          <label class="small muted">Room to show</label>
          {rooms === null ? (
            <p class="muted">Loading rooms…</p>
          ) : rooms.length === 0 ? (
            <p class="muted">You are not in any room yet.</p>
          ) : (
            <select value={selected} onChange={(e) => setSelected((e.target as HTMLSelectElement).value)}>
              {rooms.map((r) =>
                r.room && r.room.id ? (
                  <option key={r.room.id} value={r.room.id}>
                    {r.room.name || r.room.id}
                  </option>
                ) : null,
              )}
            </select>
          )}
          <button type="submit" class="primary" disabled={state === 'busy' || !selected || !typed}>
            Show on TV
          </button>
        </form>
      )}
      {error && <p class="error">{error}</p>}
    </main>
  );
}
