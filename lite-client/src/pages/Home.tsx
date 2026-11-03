import { useEffect, useState } from 'preact/hooks';
import { api } from '../auth';
import { createRoom, deleteRoom, listMyRooms } from '../api/endpoints';
import type { MyRoom, User } from '../api/types';
import { errorMessage } from '../format';
import { navigate, roomPath } from '../router';
import { confirmAction } from '../telegram';

// Auto-enter a lone room only on the first visit, not when coming back from it.
let autoEnterDone = false;

/** UserRole ROOT = 1, ADMIN = 2. The HTTP API serializes enums as integers; accept names too. */
export function isAdmin(me: User | null): boolean {
  const role = me && (me.role as unknown);
  return role === 1 || role === 2 || role === 'USER_ROLE_ROOT' || role === 'USER_ROLE_ADMIN';
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

  const remove = async (room: { id?: string; name?: string }) => {
    if (!room.id) return;
    const ok = await confirmAction(`Delete “${room.name || 'this room'}”? Its playlist, invite links and paired TVs go with it.`);
    if (!ok) return;
    setError('');
    try {
      await deleteRoom(api, room.id);
      setRooms((list) => (list ? list.filter((r) => !r.room || r.room.id !== room.id) : list));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

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
                {me && me.id && r.room.createdBy === me.id && (
                  <button class="ghost danger" onClick={() => remove(r.room!)} aria-label={`Delete ${r.room.name || 'room'}`}>
                    Delete
                  </button>
                )}
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
