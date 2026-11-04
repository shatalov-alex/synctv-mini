import { describe, expect, it } from 'vitest';
import { cueTextAt, decodeSubtitles, parseSubtitles } from './subtitles';

describe('parseSubtitles', () => {
  it('reads SRT, with Windows line ends and comma decimals', () => {
    const cues = parseSubtitles('1\r\n00:00:01,500 --> 00:00:03,000\r\nHello\r\nthere\r\n\r\n2\r\n01:00:00,000 --> 01:00:01,000\r\nLater\r\n');
    expect(cues).toEqual([
      { start: 1.5, end: 3, text: 'Hello\nthere' },
      { start: 3600, end: 3601, text: 'Later' },
    ]);
  });
  it('reads WebVTT: skips the header and notes, ignores cue settings and tags', () => {
    const cues = parseSubtitles(
      'WEBVTT\n\nNOTE a comment\n\nSTYLE\n::cue { color: red }\n\nid-1\n00:02.000 --> 00:03.250 line:0 align:start\n<v Ann><i>Hi</i> &amp; bye</v>\n',
    );
    expect(cues).toEqual([{ start: 2, end: 3.25, text: 'Hi & bye' }]);
  });
  it('reads the text of ASS, without styling', () => {
    const cues = parseSubtitles(
      '[Script Info]\nTitle: x\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.50,0:00:02.00,Default,,0,0,0,,{\\i1}One, two\\Nthree\n',
    );
    expect(cues).toEqual([{ start: 1.5, end: 2, text: 'One, two\nthree' }]);
  });
  it('treats markup as text to strip, and skips broken blocks', () => {
    const cues = parseSubtitles('00:01.000 --> nonsense\nbad\n\n00:02.000 --> 00:03.000\n<img src=x onerror=y>ok\n\n00:04.000 --> 00:05.000\n');
    expect(cues).toEqual([{ start: 2, end: 3, text: 'ok' }]);
  });
  it('returns nothing for a document that is not subtitles', () => {
    expect(parseSubtitles('<html><body>Forbidden</body></html>')).toEqual([]);
  });
});

describe('cueTextAt', () => {
  const cues = parseSubtitles('00:01.000 --> 00:03.000\nA\n\n00:02.000 --> 00:04.000\nB\n\n00:10.000 --> 00:11.000\nC\n');
  it('shows what is on screen at that moment', () => {
    expect(cueTextAt(cues, 0.5)).toBe('');
    expect(cueTextAt(cues, 1)).toBe('A');
    expect(cueTextAt(cues, 2.5)).toBe('A\nB');
    expect(cueTextAt(cues, 3)).toBe('B');
    expect(cueTextAt(cues, 5)).toBe('');
    expect(cueTextAt(cues, 10.5)).toBe('C');
  });
});

describe('decodeSubtitles', () => {
  const bytes = (...values: number[]) => new Uint8Array(values).buffer;
  it('reads UTF-8', () => {
    expect(decodeSubtitles(new TextEncoder().encode('Привет').buffer)).toBe('Привет');
  });
  it('falls back to Windows-1251 for bytes that are not UTF-8', () => {
    expect(decodeSubtitles(bytes(0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2))).toBe('Привет');
  });
  it('honours a UTF-16 byte order mark', () => {
    expect(decodeSubtitles(bytes(0xff, 0xfe, 0x41, 0x00)).replace(/^﻿/, '')).toBe('A');
  });
});
