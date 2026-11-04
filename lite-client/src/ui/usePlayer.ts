// Wires a <video> element to a VideoPlayer + RoomSyncEngine for one room.
import { useEffect, useRef, useState } from 'preact/hooks';
import { getPlayback } from '../api/endpoints';
import type { ApiClient } from '../api/http';
import type { Playback } from '../api/types';
import { VideoPlayer } from '../player/player';
import { RoomSyncEngine } from '../sync/engine';
import type { SyncEngine, SyncSnapshot } from '../sync/types';

export interface PlayerBinding {
  videoRef: { current: HTMLVideoElement | null };
  engine: SyncEngine | null;
  player: VideoPlayer | null;
  snapshot: SyncSnapshot | null;
  /** A freshly signed playback, for URLs that have expired since the snapshot's. */
  fetchPlayback: () => Promise<Playback | undefined>;
}

export function usePlayer(api: ApiClient, roomId: string, options: { remote?: boolean; roomDetails?: boolean } = {}): PlayerBinding {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [binding, setBinding] = useState<{ engine: SyncEngine; player: VideoPlayer } | null>(null);
  const [snapshot, setSnapshot] = useState<SyncSnapshot | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const player = new VideoPlayer(video);
    const engine = new RoomSyncEngine(api, player, { remote: !!options.remote, roomDetails: !!options.roomDetails });
    const off = engine.onState(setSnapshot);
    engine.connect(roomId);
    setBinding({ engine, player });
    return () => {
      off();
      engine.dispose();
      player.destroy();
      setBinding(null);
    };
  }, [api, roomId]);

  return {
    videoRef,
    engine: binding && binding.engine,
    player: binding && binding.player,
    snapshot,
    fetchPlayback: () => getPlayback(api, roomId).then((res) => res.playback),
  };
}

/** Re-renders on player time/state events (throttled by the browser's timeupdate cadence). */
export function usePlayerTick(player: VideoPlayer | null): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!player) return;
    return player.on((event) => {
      if (event.type !== 'seeking') setTick((t) => t + 1);
    });
  }, [player]);
  return tick;
}

/** Re-renders every `ms` while `on` (remote mode has no player time events). */
export function useTicker(on: boolean, ms = 500): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(timer);
  }, [on, ms]);
}
