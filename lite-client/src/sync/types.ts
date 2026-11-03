import type { PlayableSource } from '../player/source';
import type { SyncState } from './state';

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SyncSnapshot {
  connection: ConnectionStatus;
  /** Latest authoritative (or optimistic) room state; null before the first snapshot. */
  state: SyncState | null;
  /** Resolved player source for `state`, null while unknown or when nothing plays. */
  source: PlayableSource | null;
  live: boolean;
  /** Playback was started muted because of autoplay policy; next user gesture unmutes. */
  autoMuted: boolean;
  /** Autoplay refused even muted: UI must show a "tap to start" affordance calling unlock(). */
  needsGesture: boolean;
  /** Last user-visible error (command rejected, unsupported source, ...). */
  error: string | null;
  /** A next/previous HTTP call is in flight. */
  navigating: boolean;
}

/**
 * Keeps the local player in step with the room. UI gestures call the action
 * methods; the engine applies them locally first, then sends them. The engine
 * never sends anything in response to player events.
 */
export interface SyncEngine {
  connect(roomId: string): void;
  onState(listener: (snapshot: SyncSnapshot) => void): () => void;
  snapshot(): SyncSnapshot;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  setRate(rate: number): void;
  next(): Promise<void>;
  prev(): Promise<void>;
  /** Manual "Sync": forced resync (0.2 s threshold); reloads live sources. */
  syncNow(): void;
  /** Local-only: start/unmute after a user gesture when autoplay was blocked. */
  unlock(): void;
  dispose(): void;
}
