import { describe, expect, it } from 'vitest';
import { EchoGuard } from './echo';
import { preferNativeHls, isRefusal } from './player';
import { isHlsSource, pickSource } from './source';

describe('EchoGuard', () => {
  it('consumes one expectation per programmatic change', () => {
    const guard = new EchoGuard(() => 0);
    guard.expect('seek');
    guard.expect('seek');
    expect(guard.consume('seek')).toBe(true);
    expect(guard.consume('seek')).toBe(true);
    expect(guard.consume('seek')).toBe(false); // a third seeking event is external
    expect(guard.consume('play')).toBe(false);
  });
  it('drops expectations whose event never fired', () => {
    let now = 0;
    const guard = new EchoGuard(() => now, 1000);
    guard.expect('pause');
    now = 1500;
    expect(guard.consume('pause')).toBe(false);
  });
  it('cancel removes a pending expectation', () => {
    const guard = new EchoGuard(() => 0);
    guard.expect('play');
    guard.cancel('play');
    expect(guard.consume('play')).toBe(false);
  });
});

describe('source selection', () => {
  it('detects HLS by format or extension', () => {
    expect(isHlsSource('https://x/a.m3u8?sig=1')).toBe(true);
    expect(isHlsSource('https://x/a.mp4')).toBe(false);
    expect(isHlsSource('https://x/stream', 'hls')).toBe(true);
    expect(isHlsSource('https://x/a.m3u8', 'mp4')).toBe(false);
  });
  it('uses the default mode and media index, skipping unsupported formats', () => {
    const source = pickSource({
      mediaId: 'med_1',
      name: 'Movie',
      defaultMode: 'proxied',
      playbackInfos: {
        direct: { medias: [{ url: 'https://a/1.mp4' }] },
        proxied: {
          medias: [{ url: 'https://b/x.flv', format: 'flv' }, { url: 'https://b/1.m3u8' }],
          defaultMediaIndex: 0,
        },
      },
    });
    expect(source).toMatchObject({ url: 'https://b/1.m3u8', kind: 'hls', name: 'Movie', key: 'med_1|' });
  });
  it('returns null without playable media', () => {
    expect(pickSource(undefined)).toBeNull();
    expect(pickSource({ playbackInfos: {} })).toBeNull();
    expect(pickSource({ playbackInfos: { a: { medias: [{ url: 'x', format: 'dash' }] } } })).toBeNull();
  });
});

describe('HLS engine choice', () => {
  const video = (native: boolean) => ({ canPlayType: () => (native ? 'maybe' : '') }) as unknown as HTMLVideoElement;
  it('uses native HLS on Apple WebKit (Telegram iOS / Safari)', () => {
    expect(preferNativeHls(video(true), { vendor: 'Apple Computer, Inc.', hasMse: true })).toBe(true);
  });
  it('uses hls.js on Android WebViews that also claim native HLS', () => {
    expect(preferNativeHls(video(true), { vendor: 'Google Inc.', hasMse: true })).toBe(false);
  });
  it('falls back to native when there is no MSE, and never without native support', () => {
    expect(preferNativeHls(video(true), { vendor: 'Google Inc.', hasMse: false })).toBe(true);
    expect(preferNativeHls(video(false), { vendor: 'Apple Computer, Inc.', hasMse: true })).toBe(false);
  });
});

describe('isRefusal', () => {
  it('is true only for 4xx answers', () => {
    for (const code of [401, 403, 404, 410]) expect(isRefusal(code)).toBe(true);
    for (const code of [undefined, 0, 200, 500, 503]) expect(isRefusal(code)).toBe(false);
  });
});

describe('pickSource subtitles', () => {
  const playback = (subs: Record<string, object[]>, defaultSubtitleIndex?: number) => ({
    mediaId: 'm',
    defaultMode: 'direct',
    playbackInfos: Object.fromEntries(
      Object.entries(subs).map(([mode, subtitles]) => [
        mode,
        { medias: [{ url: 'https://x/a.mp4' }], subtitles, defaultSubtitleIndex },
      ]),
    ),
  });
  it('has none when the media has none', () => {
    expect(pickSource(playback({ direct: [] }))?.subtitles).toEqual([]);
  });
  it("joins one file's URLs across modes, the current mode first", () => {
    const source = pickSource(
      playback({
        proxy_direct: [{ name: 'English', language: 'en', url: '/api/signed' }],
        direct: [{ name: 'English', language: 'en', url: 'https://x/en.vtt' }],
      }),
    );
    expect(source?.subtitles).toEqual([
      { key: 'en|English', name: 'English', language: 'en', urls: ['https://x/en.vtt', '/api/signed'] },
    ]);
  });
  it('keeps only the proxy URL of a file that needs request headers', () => {
    const source = pickSource(
      playback({
        direct: [{ name: 'English', url: 'https://x/en.vtt', headers: { Referer: 'https://x' } }],
        proxy_direct: [{ name: 'English', url: '/api/signed' }],
      }),
    );
    expect(source?.subtitles[0].urls).toEqual(['/api/signed']);
  });
  it('names an unnamed track and passes the default index on', () => {
    const source = pickSource(playback({ direct: [{ url: 'https://x/1.vtt' }, { language: 'uk', url: 'https://x/2.vtt' }] }, 1));
    expect(source?.subtitles.map((t) => t.name)).toEqual(['Subtitles 1', 'uk']);
    expect(source?.defaultSubtitleIndex).toBe(1);
  });
});
