// Subtitles for the current media: which track shows, its cues, and the choice.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { MAX_SUBTITLE_BYTES, decodeSubtitles, parseSubtitles, type SubtitleCue } from '../player/subtitles';
import { pickSource, type SubtitleTrack } from '../player/source';
import { setSubtitlePrefs, subtitlePrefs, type SubtitlePrefs } from '../subtitlePrefs';
import type { PlayerBinding } from './usePlayer';

export interface SubtitleControls {
  tracks: SubtitleTrack[];
  /** The showing track; null when off or when the media has none. */
  current: SubtitleTrack | null;
  cues: SubtitleCue[];
  failed: boolean;
  select(key: string | null): void;
  /** Off, then each track in turn: what a remote's single key can do. */
  cycle(): void;
}

function chosenTrack(tracks: SubtitleTrack[], defaultIndex: number, prefs: SubtitlePrefs): SubtitleTrack | null {
  if (!prefs.on || !tracks.length) return null;
  const language = prefs.track ? prefs.track.split('|')[0] : '';
  return (
    tracks.find((t) => t.key === prefs.track) ||
    (language && tracks.find((t) => t.language === language)) ||
    tracks[defaultIndex] ||
    tracks[0]
  );
}

async function fetchCues(urls: string[]): Promise<SubtitleCue[] | null> {
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const bytes = await res.arrayBuffer();
      if (bytes.byteLength > MAX_SUBTITLE_BYTES) continue;
      const cues = parseSubtitles(decodeSubtitles(bytes));
      if (cues.length) return cues;
    } catch {
      // Commonly a host without CORS headers: the next URL is the server's proxy.
    }
  }
  return null;
}

export function useSubtitles({ snapshot, fetchPlayback }: PlayerBinding): SubtitleControls {
  const source = snapshot && !snapshot.remote ? snapshot.source : null;
  const tracks = source ? source.subtitles : [];
  const [prefs, setPrefs] = useState(subtitlePrefs);
  const [loaded, setLoaded] = useState<{ id: string; cues: SubtitleCue[] } | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  /** The URLs last refused per track: a re-issued list is worth another try, the same one isn't. */
  const refused = useRef<{ id: string; urls: string } | null>(null);

  const current = useMemo(
    () => chosenTrack(tracks, source ? source.defaultSubtitleIndex : 0, prefs),
    [source, prefs],
  );
  const id = source && current ? `${source.key}|${current.key}` : null;
  const urls = current ? current.urls.join(' ') : '';

  useEffect(() => {
    if (!id || !source || !current) return;
    if (loaded && loaded.id === id) return;
    if (refused.current && refused.current.id === id && refused.current.urls === urls) return;
    let stale = false;
    setFailedId(null);
    void (async () => {
      let cues = await fetchCues(current.urls);
      if (!cues && !stale) {
        // Proxied URLs are signed for 30 min; the viewer may turn subtitles on later than that.
        const fresh = await fetchPlayback().catch(() => undefined);
        const next = fresh ? pickSource(fresh) : null;
        const track = next && next.key === source.key ? next.subtitles.find((t) => t.key === current.key) : null;
        if (track) cues = await fetchCues(track.urls);
      }
      if (stale) return;
      if (cues) {
        setLoaded({ id, cues });
      } else {
        refused.current = { id, urls };
        setFailedId(id);
      }
    })();
    return () => {
      stale = true;
    };
  }, [id, urls]);

  const choose = (next: SubtitlePrefs) => {
    setSubtitlePrefs(next);
    setPrefs(next);
  };
  const select = (key: string | null) => choose(key ? { on: true, track: key } : { on: false, track: prefs.track });
  const cycle = () => {
    if (!tracks.length) return;
    const index = current ? tracks.indexOf(current) : -1;
    // From off, back to the first; from the last, off.
    select(index + 1 < tracks.length ? tracks[index + 1].key : null);
  };

  return {
    tracks,
    current,
    cues: loaded && loaded.id === id ? loaded.cues : [],
    failed: !!id && failedId === id,
    select,
    cycle,
  };
}
