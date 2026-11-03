// Per-room, per-device "this phone is the TV remote" preference. Set when the
// phone pairs a TV for the room; the viewer can switch back to watching here.
import { defaultStorage, type KeyValueStorage } from './api/session';

const PREFIX = 'synctv-lite.remote.';

let storage: KeyValueStorage | null = null;
function store(): KeyValueStorage {
  if (!storage) storage = defaultStorage();
  return storage;
}

export function remoteModeFor(roomId: string): boolean {
  try {
    return store().getItem(PREFIX + roomId) === '1';
  } catch {
    return false;
  }
}

export function setRemoteModeFor(roomId: string, on: boolean): void {
  try {
    if (on) store().setItem(PREFIX + roomId, '1');
    else store().removeItem(PREFIX + roomId);
  } catch {
    // per-device convenience only
  }
}
