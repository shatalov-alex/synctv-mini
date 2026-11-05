import { useEffect, useState } from 'preact/hooks';
import type { ApiClient } from '../api/http';
import {
  addDirectUrlMedia,
  clearMedia,
  deleteMedia,
  listRootMedia,
  moveMedia,
  renameMedia,
  setAutoPlay,
  startPlayback,
} from '../api/endpoints';
import type { Media } from '../api/types';
import { errorMessage } from '../format';
import { confirmAction } from '../telegram';

export function PlaylistPanel(props: {
  api: ApiClient;
  roomId: string;
  playingMediaId: string;
  /** Pushed by the room socket; once there it replaces what we fetched. */
  liveItems: Media[] | null;
  autoPlay: boolean | null;
  canManage: boolean;
}) {
  const { api, roomId, playingMediaId, liveItems, autoPlay, canManage } = props;
  const [fetched, setFetched] = useState<Media[] | null>(null);
  const items = liveItems || fetched;
  const [savingAutoPlay, setSavingAutoPlay] = useState(false);
  const [error, setError] = useState('');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [subtitleUrl, setSubtitleUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  // Nothing left to edit once the list is empty: the form to add comes back.
  useEffect(() => {
    if (items && items.length === 0) setEditing(false);
  }, [items]);

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
    const trimmedSubtitles = subtitleUrl.trim();
    if (trimmedSubtitles && !/^https?:\/\//i.test(trimmedSubtitles)) {
      setError('Enter an http(s) subtitle URL (vtt, srt, ass).');
      return;
    }
    setBusy(true);
    try {
      const media = await addDirectUrlMedia(api, roomId, trimmed, name.trim() || undefined, trimmedSubtitles || undefined);
      setUrl('');
      setName('');
      setSubtitleUrl('');
      await afterChange();
      // Start it right away when nothing is playing.
      if (!playingMediaId && media.id) await startPlayback(api, roomId, media.id, !!autoPlay);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const play = (media: Media) => {
    if (!media.id) return;
    // Response ignored: the room socket delivers the new state.
    startPlayback(api, roomId, media.id, !!autoPlay).catch((e) => setError(errorMessage(e)));
  };

  const remove = async (media: Media) => {
    if (!media.id) return;
    const title = media.name || 'this video';
    const question =
      media.id === playingMediaId ? `Remove “${title}”? It is playing now: playback stops for everyone.` : `Remove “${title}”?`;
    if (!(await confirmAction(question))) return;
    deleteMedia(api, roomId, media.id).then(afterChange, (e) => setError(errorMessage(e)));
  };

  const removeAll = async () => {
    if (!(await confirmAction('Remove all videos from the playlist? Playback stops for everyone.'))) return;
    clearMedia(api, roomId).then(afterChange, (e) => setError(errorMessage(e)));
  };

  const move = (media: Media, anchor: { beforeMediaId: string } | { afterMediaId: string }) => {
    if (!media.id) return;
    moveMedia(api, roomId, media.id, anchor).then(afterChange, (e) => setError(errorMessage(e)));
  };

  const saveName = (event: Event) => {
    event.preventDefault();
    if (!renaming) return;
    const { id, name: draft } = renaming;
    setRenaming(null);
    if (draft.trim()) renameMedia(api, roomId, id, draft.trim()).then(afterChange, (e) => setError(errorMessage(e)));
  };

  const toggleAutoPlay = (event: Event) => {
    const input = event.target as HTMLInputElement;
    const enabled = input.checked;
    // Shown as the room has it: the socket delivers the change, to everyone.
    input.checked = !!autoPlay;
    setSavingAutoPlay(true);
    setAutoPlay(api, roomId, enabled)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setSavingAutoPlay(false));
  };

  return (
    <section class="card">
      <div class="row playlist-head">
        <h2 class="grow">Playlist</h2>
        {canManage && items && items.length > 0 && (
          <button
            class="ghost small"
            onClick={() => {
              setEditing(!editing);
              setRenaming(null);
            }}
          >
            {editing ? 'Done' : 'Edit'}
          </button>
        )}
        <label class="small muted autoplay">
          <input
            type="checkbox"
            checked={!!autoPlay}
            disabled={!canManage || autoPlay === null || savingAutoPlay}
            onChange={toggleAutoPlay}
          />
          Autoplay
        </label>
      </div>
      {items === null && !error && <p class="muted">Loading…</p>}
      {items && items.length === 0 && <p class="muted">No videos yet.</p>}
      {items && items.length > 0 && (
        <ul class="list">
          {items.map((m, index) => (
            <li key={m.id} class={m.id === playingMediaId ? 'active' : ''}>
              {renaming && renaming.id === m.id ? (
                <form class="rename grow" onSubmit={saveName}>
                  <input
                    type="text"
                    aria-label="Title"
                    maxLength={500}
                    value={renaming.name}
                    onInput={(e) => setRenaming({ id: renaming.id, name: (e.target as HTMLInputElement).value })}
                  />
                  <button type="submit" class="ghost" aria-label="Save title">
                    ✓
                  </button>
                </form>
              ) : (
                <button class="link grow" onClick={() => play(m)}>
                  {m.id === playingMediaId ? '▶ ' : ''}
                  {m.name || 'Untitled'}
                </button>
              )}
              {canManage && editing && (
                <>
                  <button
                    class="ghost"
                    aria-label="Move up"
                    disabled={index === 0}
                    onClick={() => move(m, { beforeMediaId: items[index - 1].id || '' })}
                  >
                    ↑
                  </button>
                  <button
                    class="ghost"
                    aria-label="Move down"
                    disabled={index === items.length - 1}
                    onClick={() => move(m, { afterMediaId: items[index + 1].id || '' })}
                  >
                    ↓
                  </button>
                  <button
                    class="ghost"
                    aria-label="Rename"
                    onClick={() => setRenaming({ id: m.id || '', name: m.name || '' })}
                  >
                    ✎
                  </button>
                </>
              )}
              {canManage && (
                <button class="ghost" onClick={() => remove(m)} aria-label="Remove">
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && editing && (
        <button class="ghost danger" onClick={removeAll}>
          Remove all
        </button>
      )}
      {canManage && !editing && (
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
          <input
            type="url"
            inputMode="url"
            placeholder="Subtitles link (optional): https://…/subtitles.vtt"
            value={subtitleUrl}
            onInput={(e) => setSubtitleUrl((e.target as HTMLInputElement).value)}
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
