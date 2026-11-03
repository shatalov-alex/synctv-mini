import { useEffect, useState } from 'preact/hooks';
import { api } from '../auth';
import { getRoom } from '../api/endpoints';
import type { Room as RoomInfo, User } from '../api/types';
import { errorMessage } from '../format';
import { navigate } from '../router';
import { telegram, useBackButtonEffect } from '../telegram';
import { InvitePanel } from '../ui/InvitePanel';
import { PairTvPanel } from '../ui/PairTvPanel';
import { PlayerPanel } from '../ui/PlayerPanel';
import { PlaylistPanel } from '../ui/PlaylistPanel';
import { usePlayer } from '../ui/usePlayer';

export function Room({ roomId, me }: { roomId: string; me: User | null }) {
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [error, setError] = useState('');
  const binding = usePlayer(api, roomId);
  const snapshot = binding.snapshot;

  useEffect(() => {
    getRoom(api, roomId).then(
      (res) => setRoom(res.room || null),
      (e) => setError(errorMessage(e)),
    );
  }, [roomId]);

  useEffect(() => useBackButtonEffect(() => navigate('/')), []);

  const isCreator = !!(me && me.id && room && room.createdBy === me.id);

  return (
    <main class="page room">
      <header class="room-header">
        {!telegram() && (
          <button class="ghost" onClick={() => navigate('/')} aria-label="Back">
            ←
          </button>
        )}
        <h1 class="grow">{room ? room.name || 'Room' : 'Room'}</h1>
      </header>
      {error && <p class="error">{error}</p>}
      <PlayerPanel binding={binding} />
      <PlaylistPanel
        api={api}
        roomId={roomId}
        playingMediaId={snapshot && snapshot.state ? snapshot.state.mediaId : ''}
        canManage={isCreator}
      />
      {isCreator && <InvitePanel api={api} roomId={roomId} />}
      <PairTvPanel api={api} roomId={roomId} />
    </main>
  );
}
