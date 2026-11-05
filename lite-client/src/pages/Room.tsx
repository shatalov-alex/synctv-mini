import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../auth';
import { deleteRoom, getRoom } from '../api/endpoints';
import type { Room as RoomInfo, User } from '../api/types';
import { listTvDevices, type TvDevice } from '../api/tv';
import { errorMessage } from '../format';
import { navigate } from '../router';
import { confirmAction, telegram, useBackButtonEffect } from '../telegram';
import { InvitePanel } from '../ui/InvitePanel';
import { PairTvPanel } from '../ui/PairTvPanel';
import { PlayerPanel } from '../ui/PlayerPanel';
import { PlaylistPanel } from '../ui/PlaylistPanel';
import { usePlayer } from '../ui/usePlayer';
import { ViewersPanel } from '../ui/ViewersPanel';
import { remoteModeFor, setRemoteModeFor } from '../remoteMode';

export function Room({ roomId, me }: { roomId: string; me: User | null }) {
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [error, setError] = useState('');
  const binding = usePlayer(api, roomId, { remote: remoteModeFor(roomId), roomDetails: true });
  const snapshot = binding.snapshot;
  // The room's TVs; null until known, so a failed read never throws a phone out of remote mode.
  const [tvs, setTvs] = useState<TvDevice[] | null>(null);
  const tvRequest = useRef(0);
  const reloadTvs = () => {
    const request = ++tvRequest.current;
    return listTvDevices(api, roomId).then((list) => {
      if (request === tvRequest.current) setTvs(list);
    });
  };
  const connected = !!snapshot && snapshot.connection === 'open';
  const memberChanges = snapshot ? snapshot.memberChanges : 0;
  // Pairing and unpairing show up as member changes; a reconnect may have missed them.
  useEffect(() => {
    if (connected) reloadTvs().catch(() => {});
  }, [roomId, connected, memberChanges]);
  // No TV to be the remote of: this phone plays again, whatever it remembered.
  const remote = !!snapshot && snapshot.remote;
  useEffect(() => {
    if (tvs && tvs.length === 0 && remote && binding.engine) {
      setRemoteModeFor(roomId, false);
      binding.engine.setRemote(false);
    }
  }, [tvs, remote, binding.engine]);

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
      <PlayerPanel
        binding={binding}
        canUseRemote={!!tvs && tvs.length > 0}
        onRemoteChange={(on) => setRemoteModeFor(roomId, on)}
      />
      <PlaylistPanel
        api={api}
        roomId={roomId}
        playingMediaId={snapshot && snapshot.state ? snapshot.state.mediaId : ''}
        liveItems={snapshot ? snapshot.playlist : null}
        autoPlay={snapshot ? snapshot.autoPlay : null}
        canManage={isCreator}
      />
      <ViewersPanel api={api} roomId={roomId} refreshKey={`${connected}:${memberChanges}:${tvs ? tvs.length : 0}`} canRemove={isCreator} />
      {isCreator && <InvitePanel api={api} roomId={roomId} />}
      <PairTvPanel
        api={api}
        roomId={roomId}
        isCreator={isCreator}
        tvs={tvs || []}
        reloadTvs={reloadTvs}
        onPaired={() => {
          // The TV plays now; this phone becomes its remote (switchable in the player).
          setRemoteModeFor(roomId, true);
          return reloadTvs()
            .catch(() => {})
            .then(() => {
              if (binding.engine) binding.engine.setRemote(true);
            });
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
