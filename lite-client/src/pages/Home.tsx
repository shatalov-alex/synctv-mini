import { useEffect, useState } from 'preact/hooks';
import { api } from '../auth';
import { createRoom, listMyRooms } from '../api/endpoints';
import type { MyRoom, User } from '../api/types';
import { errorMessage } from '../format';
import { navigate, roomPath } from '../router';

// Auto-enter a lone room only on the first visit, not when coming back from it.
let autoEnterDone = false;

export function isAdmin(me: User | null): boolean {
  return !!me && (me.role === 'USER_ROLE_ADMIN' || me.role === 'USER_ROLE_ROOT');
}

export function Home({ me }: { me: User | null }) {
  const [rooms, setRooms] = useState<MyRoom[] | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listMyRooms(api).then(
      (list) => {
        setRooms(list);
        // Exactly one room (the usual case for a guest): go straight in.
        const first = !autoEnterDone;
        autoEnterDone = true;
        if (first && list.length === 1 && list[0].room && list[0].room.id) navigate(roomPath(list[0].room.id));
      },
      (e) => setError(errorMessage(e)),
    );
  }, []);

  const create = async (event: Event) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const room = await createRoom(api, trimmed);
      if (room.id) navigate(roomPath(room.id));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <main class="page">
      <h1>Rooms</h1>
      {me && me.username && <p class="muted small">Signed in as {me.username}</p>}
      {rooms === null && !error && <p class="muted">Loading…</p>}
      {rooms && rooms.length === 0 && <p class="muted">No rooms yet.</p>}
      {rooms && rooms.length > 0 && (
        <ul class="list card">
          {rooms.map((r) =>
            r.room && r.room.id ? (
              <li key={r.room.id}>
                <button class="link grow" onClick={() => navigate(roomPath(r.room!.id!))}>
                  {r.room.name || r.room.id}
                </button>
                <span class="muted small">{r.room.memberCount || 0} 👤</span>
              </li>
            ) : null,
          )}
        </ul>
      )}
      {isAdmin(me) && (
      <form class="card row" onSubmit={create}>
        <input
          type="text"
          placeholder="New room name"
          maxLength={100}
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value.replace(/[<>]/g, ''))}
        />
        <button type="submit" class="primary" disabled={busy || !name.trim()}>
          Create
        </button>
      </form>
      )}
      {error && <p class="error">{error}</p>}
    </main>
  );
}
