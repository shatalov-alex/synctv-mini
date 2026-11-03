import { describe, expect, it } from 'vitest';
import { EchoGuard } from './echo';
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
