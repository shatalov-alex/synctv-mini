import { useEffect, useState } from 'preact/hooks';
import type { ApiClient } from '../api/http';
import { addDirectUrlMedia, deleteMedia, listRootMedia, startPlayback } from '../api/endpoints';
import type { Media } from '../api/types';
import { errorMessage } from '../format';
import { confirmAction } from '../telegram';

export function PlaylistPanel(props: {
  api: ApiClient;
  roomId: string;
  playingMediaId: string;
  /** Pushed by the room socket; once there it replaces what we fetched. */
  liveItems: Media[] | null;
  canManage: boolean;
}) {
  const { api, roomId, playingMediaId, liveItems, canManage } = props;
  const [fetched, setFetched] = useState<Media[] | null>(null);
  const items = liveItems || fetched;
  const [error, setError] = useState('');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = () =>
    listRootMedia(api, roomId).then(
      (media) => {
        setFetched(media);
        setError('');
      },
      (e) => setError(errorMessage(e)),
    );

  useEffect(() => {
    void reload();
  }, [roomId]);
  // Re-read the list when playback moves to an item we don't know yet.
  useEffect(() => {
    if (!liveItems && playingMediaId && items && !items.some((m) => m.id === playingMediaId)) void reload();
  }, [playingMediaId]);

  // The socket delivers our own changes too; fetch only without it.
  const afterChange = async () => {
    setError('');
    if (!liveItems) await reload();
  };

  const add = async (event: Event) => {
    event.preventDefault();
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      setError('Enter an http(s) video URL (mp4, webm, m3u8, …).');
      return;
    }
    setBusy(true);
    try {
      const media = await addDirectUrlMedia(api, roomId, trimmed, name.trim() || undefined);
      setUrl('');
      setName('');
      await afterChange();
      // Start it right away when nothing is playing.
      if (!playingMediaId && media.id) await startPlayback(api, roomId, media.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const play = (media: Media) => {
    if (!media.id) return;
    // Response ignored: the room socket delivers the new state.
    startPlayback(api, roomId, media.id).catch((e) => setError(errorMessage(e)));
  };

  const remove = async (media: Media) => {
    if (!media.id || !(await confirmAction(`Remove “${media.name || 'this video'}”?`))) return;
    deleteMedia(api, roomId, media.id).then(afterChange, (e) => setError(errorMessage(e)));
  };

  return (
    <section class="card">
      <h2>Playlist</h2>
      {items === null && !error && <p class="muted">Loading…</p>}
      {items && items.length === 0 && <p class="muted">No videos yet.</p>}
      {items && items.length > 0 && (
        <ul class="list">
          {items.map((m) => (
            <li key={m.id} class={m.id === playingMediaId ? 'active' : ''}>
              <button class="link grow" onClick={() => play(m)}>
                {m.id === playingMediaId ? '▶ ' : ''}
                {m.name || 'Untitled'}
              </button>
              {canManage && (
                <button class="ghost" onClick={() => remove(m)} aria-label="Remove">
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <form class="stack" onSubmit={add}>
          <input
            type="url"
            inputMode="url"
            placeholder="https://…/video.mp4 or .m3u8"
            value={url}
            onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
          />
          <input
            type="text"
            placeholder="Title (optional)"
            maxLength={500}
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
          <button type="submit" class="primary" disabled={busy || !url}>
            {busy ? 'Adding…' : 'Add video'}
          </button>
        </form>
      )}
      {error && <p class="error">{error}</p>}
    </section>
  );
}
