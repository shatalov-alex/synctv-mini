// Per-device subtitle preference: on by default, and the track last chosen, so
// the next episode opens with the same language. Not shared with the room.
import { defaultStorage, type KeyValueStorage } from './api/session';

const KEY = 'synctv-lite.subtitles';

export interface SubtitlePrefs {
  on: boolean;
  track: string | null;
}

let storage: KeyValueStorage | null = null;
function store(): KeyValueStorage {
  if (!storage) storage = defaultStorage();
  return storage;
}

export function subtitlePrefs(): SubtitlePrefs {
  try {
    const saved = JSON.parse(store().getItem(KEY) || '{}') as Partial<SubtitlePrefs>;
    return { on: saved.on !== false, track: typeof saved.track === 'string' ? saved.track : null };
  } catch {
    return { on: true, track: null };
  }
}

export function setSubtitlePrefs(prefs: SubtitlePrefs): void {
  try {
    store().setItem(KEY, JSON.stringify(prefs));
  } catch {
    // per-device convenience only
  }
}
