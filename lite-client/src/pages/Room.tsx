import { useEffect, useState } from 'preact/hooks';
import { api } from '../auth';
import { deleteRoom, getRoom } from '../api/endpoints';
import type { Room as RoomInfo, User } from '../api/types';
import { errorMessage } from '../format';
import { navigate } from '../router';
import { confirmAction, telegram, useBackButtonEffect } from '../telegram';
import { InvitePanel } from '../ui/InvitePanel';
import { PairTvPanel } from '../ui/PairTvPanel';
import { PlayerPanel } from '../ui/PlayerPanel';
import { PlaylistPanel } from '../ui/PlaylistPanel';
import { usePlayer } from '../ui/usePlayer';
import { remoteModeFor, setRemoteModeFor } from '../remoteMode';

export function Room({ roomId, me }: { roomId: string; me: User | null }) {
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [error, setError] = useState('');
  const binding = usePlayer(api, roomId, { remote: remoteModeFor(roomId) });
  const snapshot = binding.snapshot;

  useEffect(() => {
    getRoom(api, roomId).then(
      (res) => setRoom(res.room || null),
      (e) => setError(errorMessage(e)),
    );
  }, [roomId]);

  useEffect(() => useBackButtonEffect(() => navigate('/')), []);

  const isCreator = !!(me && me.id && room && room.createdBy === me.id);

  const remove = async () => {
    const ok = await confirmAction(`Delete “${(room && room.name) || 'this room'}”? Everyone in it is disconnected.`);
    if (!ok) return;
    try {
      await deleteRoom(api, roomId);
      navigate('/', true);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

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
      {snapshot && snapshot.accessLost && (
        <p class="error">
          {snapshot.accessLost}{' '}
          <button class="ghost" onClick={() => navigate('/')}>
            Back to rooms
          </button>
        </p>
      )}
      <PlayerPanel binding={binding} onRemoteChange={(on) => setRemoteModeFor(roomId, on)} />
      <PlaylistPanel
        api={api}
        roomId={roomId}
        playingMediaId={snapshot && snapshot.state ? snapshot.state.mediaId : ''}
        canManage={isCreator}
      />
      {isCreator && <InvitePanel api={api} roomId={roomId} />}
      <PairTvPanel
        api={api}
        roomId={roomId}
        isCreator={isCreator}
        onPaired={() => {
          // The TV plays now; this phone becomes its remote (switchable in the player).
          setRemoteModeFor(roomId, true);
          if (binding.engine) binding.engine.setRemote(true);
        }}
      />
      {isCreator && (
        <button class="ghost danger delete-room" onClick={remove}>
          Delete room
        </button>
      )}
    </main>
  );
}
