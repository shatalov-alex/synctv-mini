// Subtitle documents: decoding and parsing. Upstream SyncTV's clients draw
// subtitles themselves from the same document formats; so do we, because the
// player's fullscreen is its container, not the <video>.

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

/** A document larger than this is not a subtitle file; don't parse it on a phone or TV. */
export const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;

/**
 * Text of a subtitle file. Files are usually UTF-8, but many .srt files are
 * still in a legacy code page, which a strict decode detects; Windows-1251 is
 * the guess because it is what this service's Cyrillic files would be in.
 */
export function decodeSubtitles(bytes: ArrayBuffer): string {
  const data = new Uint8Array(bytes);
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data);
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return new TextDecoder('windows-1251').decode(data);
  }
}

function seconds(stamp: string): number | null {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,:](\d{1,3})$/.exec(stamp.trim());
  if (!match) return null;
  const fraction = Number(match[4]) / 10 ** match[4].length;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + fraction;
}

function plainText(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function parseCueBlocks(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const block of content.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const timing = lines.findIndex((line) => line.includes('-->'));
    if (timing < 0) continue;
    const [from, to] = lines[timing].split('-->');
    // A VTT end stamp may be followed by cue settings.
    const start = seconds(from);
    const end = seconds((to || '').trim().split(/\s+/)[0]);
    const text = plainText(lines.slice(timing + 1).join('\n'));
    if (start !== null && end !== null && text) cues.push({ start, end, text });
  }
  return cues;
}

/** ASS and SSA: the text of each Dialogue line, without styling or positioning. */
function parseAss(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let fields: string[] = [];
  for (const line of content.split('\n')) {
    if (/^\[.*\]/.test(line)) fields = [];
    else if (line.startsWith('Format:')) fields = line.slice(7).split(',').map((f) => f.trim().toLowerCase());
    else if (line.startsWith('Dialogue:') && fields.length) {
      const values = line.slice(9).split(',');
      const at = (name: string) => values[fields.indexOf(name)] || '';
      const start = seconds(at('start'));
      const end = seconds(at('end'));
      const text = plainText(
        values
          .slice(fields.indexOf('text'))
          .join(',')
          .replace(/\{[^}]*\}/g, '')
          .replace(/\\[Nn]/g, '\n')
          .replace(/\\h/g, ' '),
      );
      if (start !== null && end !== null && text) cues.push({ start, end, text });
    }
  }
  return cues;
}

/** Parses SRT, WebVTT or ASS by content, as the file's extension and format field can't be trusted. */
export function parseSubtitles(content: string): SubtitleCue[] {
  const text = content.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const cues = /^\[Script Info\]|^\[Events\]/m.test(text) ? parseAss(text) : parseCueBlocks(text);
  return cues.sort((a, b) => a.start - b.start);
}

/** The text showing at a moment: cues may overlap, then they stack in time order. */
export function cueTextAt(cues: SubtitleCue[], time: number): string {
  let text = '';
  for (const cue of cues) {
    if (cue.start > time) break;
    if (time < cue.end) text = text ? `${text}\n${cue.text}` : cue.text;
  }
  return text;
}
