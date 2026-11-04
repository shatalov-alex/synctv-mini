// Picks a playable URL out of a GetPlayback response.
import type { Playback, PlaybackInfo } from '../api/types';

export type SourceKind = 'hls' | 'file';

export interface SubtitleTrack {
  /** Stays the same across episodes and re-issued URLs, unlike the URL. */
  key: string;
  name: string;
  language: string;
  /** The current mode's URL first, then the same file through the other modes. */
  urls: string[];
}

export interface PlayableSource {
  url: string;
  kind: SourceKind;
  /** Source key used to detect "same media, don't reload". */
  key: string;
  name: string;
  /** Non-empty when the server wants custom request headers, which <video> cannot send. */
  requiresHeaders: boolean;
  subtitles: SubtitleTrack[];
  defaultSubtitleIndex: number;
}

export function isHlsSource(url: string, format?: string): boolean {
  const f = (format || '').toLowerCase();
  if (f === 'hls' || f === 'm3u8' || f === 'hls_remux') return true;
  if (f && f !== 'auto') return false;
  const path = url.split('?')[0].split('#')[0].toLowerCase();
  return /\.m3u8?$/.test(path);
}

export function unsupportedFormat(format?: string): boolean {
  const f = (format || '').toLowerCase();
  return f === 'flv' || f === 'dash' || f === 'mpd' || f === 'webrtc' || f === 'whep';
}

/**
 * A host's subtitle file is often readable only through the proxy mode (no CORS
 * headers, or request headers fetch can't send), so collect every mode's URL.
 */
function collectSubtitles(infos: Record<string, PlaybackInfo>, mode: string): SubtitleTrack[] {
  const tracks: SubtitleTrack[] = [];
  for (const name of [mode, ...Object.keys(infos).filter((m) => m !== mode)]) {
    for (const subtitle of infos[name].subtitles || []) {
      if (!subtitle.url) continue;
      const language = subtitle.language || '';
      const label = subtitle.name || language || `Subtitles ${tracks.length + 1}`;
      const key = `${language}|${label}`;
      let track = tracks.find((t) => t.key === key);
      if (!track) {
        track = { key, name: label, language, urls: [] };
        tracks.push(track);
      }
      const needsHeaders = !!subtitle.headers && Object.keys(subtitle.headers).length > 0;
      if (!needsHeaders && !track.urls.includes(subtitle.url)) track.urls.push(subtitle.url);
    }
  }
  return tracks.filter((t) => t.urls.length > 0);
}

export function pickSource(playback: Playback | undefined): PlayableSource | null {
  if (!playback || !playback.playbackInfos) return null;
  const infos = playback.playbackInfos;
  const modes = Object.keys(infos);
  if (!modes.length) return null;
  const mode = playback.defaultMode && infos[playback.defaultMode] ? playback.defaultMode : modes[0];
  const info = infos[mode];
  const medias = (info.medias || []).filter((m) => m.url && !unsupportedFormat(m.format));
  if (!medias.length) return null;
  const index = info.defaultMediaIndex || 0;
  const media = medias[index] || medias[0];
  const url = media.url as string;
  return {
    url,
    kind: isHlsSource(url, media.format) ? 'hls' : 'file',
    // Signed URLs change on every fetch; identify the media, not the URL.
    key: playback.mediaId ? `${playback.mediaId}|${playback.playlistId || ''}` : url,
    name: playback.name || media.name || '',
    requiresHeaders: !!media.headers && Object.keys(media.headers).length > 0,
    subtitles: collectSubtitles(infos, mode),
    defaultSubtitleIndex: info.defaultSubtitleIndex || 0,
  };
}
