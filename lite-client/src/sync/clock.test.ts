import { describe, expect, it } from 'vitest';
import { nanosToMs, offsetFromSample, ServerClock } from './clock';
import { heartbeatMessage, parseIncoming, playbackUpdateMessage, wsUrl } from './protocol';

describe('clock math', () => {
  it('parses int64 nanos strings without precision loss', () => {
    expect(nanosToMs('1762160000123456789')).toBeCloseTo(1762160000123.4568, 3);
    expect(nanosToMs('500000')).toBe(0.5);
    expect(nanosToMs(undefined)).toBe(0);
  });

  it('computes the NTP offset', () => {
    // local is 1000 ms behind the server; 40 ms each way; 2 ms server processing
    expect(offsetFromSample({ t0: 10_000, t1: 11_040, t2: 11_042, t3: 10_082 })).toBe(1000);
  });

  it('rejects invalid samples', () => {
    expect(offsetFromSample({ t0: 0, t1: 1, t2: 2, t3: 3 })).toBeNull();
    expect(offsetFromSample({ t0: 10, t1: 20, t2: 19, t3: 30 })).toBeNull(); // t2 < t1
    expect(offsetFromSample({ t0: 10, t1: 20, t2: 21, t3: 9 })).toBeNull(); // t3 < t0
    expect(offsetFromSample({ t0: 10, t1: 20, t2: 40, t3: 15 })).toBeNull(); // rtt < 0
  });
});

describe('ServerClock', () => {
  it('applies a valid sample and echoes the exact nanos string', async () => {
    let local = 1_000_000;
    let sent = '';
    const clock = new ServerClock(async (s) => {
      sent = s;
      local += 100;
      return { clientSentAtNanos: s, serverReceivedAtNanos: '1500050000000', serverSentAtNanos: '1500050000000' };
    }, () => local);
    await clock.sample();
    expect(sent).toBe('1000000000000');
    // server stamps 1_500_050 ms; local midpoint is 1_000_050 ms
    expect(clock.offset).toBe(500_000);
    expect(clock.now()).toBe(local + clock.offset);
  });

  it('discards stale responses', async () => {
    const clock = new ServerClock(async () => ({ clientSentAtNanos: '1', serverReceivedAtNanos: '9000000', serverSentAtNanos: '9000000' }), () => 5);
    await clock.sample();
    expect(clock.offset).toBe(0);
  });

  it('resets the offset to 0 on failure (official client behaviour)', async () => {
    let fail = false;
    const clock = new ServerClock(async (s) => {
      if (fail) throw new Error('timeout');
      return { clientSentAtNanos: s, serverReceivedAtNanos: '6000000000', serverSentAtNanos: '6000000000' };
    }, () => 1000);
    await clock.sample();
    expect(clock.offset).toBe(5000);
    fail = true;
    await clock.sample();
    expect(clock.offset).toBe(0);
  });
});

describe('ws protocol', () => {
  it('builds the socket URL', () => {
    expect(wsUrl('https://tv.example', 'room_a', 't/1')).toBe('wss://tv.example/ws/rooms/room_a?ticket=t%2F1&format=json');
    expect(wsUrl('http://localhost:5173', 'room_a', 't')).toBe('ws://localhost:5173/ws/rooms/room_a?ticket=t&format=json');
  });

  it('encodes commands with integer enums, int64 strings and optional guards', () => {
    expect(
      playbackUpdateMessage({
        kind: 'seek',
        playing: true,
        position: 12.5,
        expectedMediaId: 'med_1',
        expectedPlaylistId: '',
        expectedTargetHash: '',
        opId: 'op',
        clientTimeMs: 1762160000123.4,
      }),
    ).toEqual({
      playbackStateUpdate: {
        type: 3,
        playing: true,
        position: 12.5,
        expectedMediaId: 'med_1',
        clientOperationId: 'op',
        clientTimeMillis: '1762160000123',
      },
    });
    expect(heartbeatMessage(1762160000000.6)).toEqual({ heartbeat: { timestamp: '1762160000001' } });
  });

  it('classifies incoming frames', () => {
    expect(
      parseIncoming('{"resourceEvent":{"observeId":"playback_state","playbackState":{"version":"3"},"eventCursor":{"sequence":"1"}}}'),
    ).toEqual({ kind: 'state', state: { version: '3' } });
    expect(parseIncoming('{"resourceEvent":{"observeId":"playback","playback":{"mediaId":"m"}}}')).toEqual({
      kind: 'playback',
      playback: { mediaId: 'm' },
    });
    expect(parseIncoming('{"resourceEvent":{"observeId":"playback"}}')).toEqual({ kind: 'playback', playback: {} });
    expect(parseIncoming('{"error":{"code":2003,"message":"conflict","clientOperationId":"op"}}')).toEqual({
      kind: 'error',
      code: 2003,
      message: 'conflict',
      opId: 'op',
    });
    expect(parseIncoming('{"resourceEvent":{"observeId":"playlist_items","playlistItems":{"media":[{"id":"m"}]}}}')).toEqual({
      kind: 'playlist',
      media: [{ id: 'm' }],
    });
    expect(parseIncoming('{"resourceEvent":{"observeId":"playlist_items"}}')).toEqual({ kind: 'playlist', media: [] });
    expect(parseIncoming('{"resourceEvent":{"observeId":"playlist_items","changedOnly":{}}}')).toEqual({ kind: 'other' });
    expect(parseIncoming('{"heartbeatAck":{"timestamp":"1"}}')).toEqual({ kind: 'other' });
    expect(parseIncoming('not json')).toEqual({ kind: 'other' });
  });
});
