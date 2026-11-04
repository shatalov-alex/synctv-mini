import { describe, expect, it } from 'vitest';
import {
  MAX_PULL_BACK_S,
  PULL_BACK_INTERVAL_MS,
  READY_BUFFER_S,
  STALL_GRACE_MS,
  expectedPosition,
  isStale,
  needsCorrection,
  nextReady,
  nextReconnect,
  planSync,
  sameSource,
  shouldPullBack,
  stateFromWire,
  type PlayerView,
  type SyncState,
} from './state';

const T = 1_800_000_000_000;

function st(over: Partial<SyncState> = {}): SyncState {
  return {
    mediaId: 'med_1',
    playlistId: '',
    targetHash: '',
    playing: true,
    position: 100,
    speed: 1,
    generatedAtMs: T,
    version: 5,
    opId: '',
    ...over,
  };
}

function pv(over: Partial<PlayerView> = {}): PlayerView {
  return { currentTime: 100, paused: false, playbackRate: 1, duration: 3600, ...over };
}

describe('stateFromWire', () => {
  it('fills pbjson defaults, parses int64 strings, maps speed 0 to 1', () => {
    expect(stateFromWire({ playingMediaId: 'm', version: '42', generatedAtMillis: '1762160000200' })).toEqual({
      mediaId: 'm',
      playlistId: '',
      targetHash: '',
      playing: false,
      position: 0,
      speed: 1,
      generatedAtMs: 1762160000200,
      version: 42,
      opId: '',
    });
  });
});

describe('version guard and source identity', () => {
  it('drops strictly older versions only', () => {
    expect(isStale(st({ version: 4 }), st({ version: 5 }))).toBe(true);
    expect(isStale(st({ version: 5 }), st({ version: 5 }))).toBe(false);
    expect(isStale(st({ version: 1 }), null)).toBe(false);
  });
  it('compares media, playlist and target hash', () => {
    expect(sameSource(st(), st({ position: 1 }))).toBe(true);
    expect(sameSource(st(), st({ targetHash: 'h' }))).toBe(false);
    expect(sameSource(st(), st({ playlistId: 'pl_1' }))).toBe(false);
  });
});

describe('expectedPosition', () => {
  it('advances by elapsed server time × speed while playing', () => {
    expect(expectedPosition(st({ speed: 1.5 }), T + 2000, 0)).toEqual({ position: 103, atEnd: false });
  });
  it('does not advance when paused or without a generation stamp', () => {
    expect(expectedPosition(st({ playing: false }), T + 5000, 0).position).toBe(100);
    expect(expectedPosition(st({ generatedAtMs: 0 }), T + 5000, 0).position).toBe(100);
  });
  it('ignores negative elapsed time (clock skew)', () => {
    expect(expectedPosition(st(), T - 5000, 0).position).toBe(100);
  });
  it('clamps to 0 and to the duration (at end)', () => {
    expect(expectedPosition(st({ position: -3, playing: false }), T, 0)).toEqual({ position: 0, atEnd: false });
    expect(expectedPosition(st({ position: NaN }), T, 0).position).toBe(0);
    expect(expectedPosition(st({ position: 3599 }), T + 2000, 3600)).toEqual({ position: 3600, atEnd: true });
  });
});

describe('planSync', () => {
  it('does nothing inside the 1.2 s band', () => {
    expect(planSync(st(), pv({ currentTime: 101.1 }), T)).toEqual({ rate: null, pause: false, seek: null, play: false });
  });
  it('hard-seeks to the exact target (ms-truncated) when drift > 1.2 s', () => {
    expect(planSync(st({ position: 100.12345 }), pv({ currentTime: 98.9 }), T).seek).toBe(100.123);
    expect(planSync(st(), pv({ currentTime: 98.8 }), T).seek).toBe(100);
  });
  it('uses the 0.2 s threshold for forced syncs', () => {
    expect(planSync(st(), pv({ currentTime: 100.25 }), T, { forceSeek: true }).seek).toBe(100);
    expect(planSync(st(), pv({ currentTime: 100.15 }), T, { forceSeek: true }).seek).toBeNull();
    expect(planSync(st(), pv({ currentTime: 100.25 }), T).seek).toBeNull();
  });
  it('applies rate, then pause, then seek, then play', () => {
    expect(planSync(st({ speed: 2, playing: false }), pv({ currentTime: 50 }), T)).toEqual({
      rate: 2,
      pause: true,
      seek: 100,
      play: false,
    });
    expect(planSync(st(), pv({ paused: true }), T)).toEqual({ rate: null, pause: false, seek: null, play: true });
  });
  it('at end: pause and seek to the duration', () => {
    expect(planSync(st({ position: 3700 }), pv({ currentTime: 3599.5 }), T)).toEqual({
      rate: null,
      pause: true,
      seek: 3600,
      play: false,
    });
  });
  it('free mode disables auto-seek but not forced seeks', () => {
    expect(planSync(st(), pv({ currentTime: 50 }), T, { freeMode: true }).seek).toBeNull();
    expect(planSync(st(), pv({ currentTime: 50 }), T, { freeMode: true, forceSeek: true }).seek).toBe(100);
  });
  it('never seeks live sources', () => {
    expect(planSync(st(), pv({ currentTime: 0 }), T, { live: true, forceSeek: true }).seek).toBeNull();
  });
});

describe('needsCorrection (2 s loop)', () => {
  it('fires on play-state mismatch or drift > 1.2 s', () => {
    expect(needsCorrection(st(), pv(), T)).toBe(false);
    expect(needsCorrection(st(), pv({ paused: true }), T)).toBe(true);
    expect(needsCorrection(st(), pv({ currentTime: 101.3 }), T)).toBe(true);
    expect(needsCorrection(st(), pv({ currentTime: 101.1 }), T)).toBe(false);
  });
  it('a stalled player falls behind and gets corrected', () => {
    // Buffering: still "playing", position frozen at 100 while the room moved on 1.5 s.
    expect(needsCorrection(st(), pv(), T + 1500)).toBe(true);
  });
  it('is off in free mode', () => {
    expect(needsCorrection(st(), pv({ paused: true }), T, { freeMode: true })).toBe(false);
  });
});

describe('reconnect backoff', () => {
  it('is 2 s × attempt, capped at 10 s', () => {
    let attempts = 0;
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const next = nextReconnect(attempts);
      attempts = next.attempts;
      delays.push(next.delayMs);
    }
    expect(delays).toEqual([2000, 4000, 6000, 8000, 10000, 10000, 10000]);
  });
});

describe('nextReady', () => {
  const view = { loaded: true, paused: true, buffering: false, stalledMs: 0, readyState: 4, bufferedAhead: 0, atEnd: false };

  it('needs the video loaded', () => {
    expect(nextReady(true, { ...view, loaded: false })).toBe(false);
  });

  it('a stopped player needs a real buffer', () => {
    expect(nextReady(true, { ...view, readyState: 2, bufferedAhead: 1 })).toBe(false);
    expect(nextReady(false, { ...view, readyState: 3, bufferedAhead: READY_BUFFER_S })).toBe(true);
    expect(nextReady(false, view)).toBe(true);
    expect(nextReady(false, { ...view, readyState: 1, atEnd: true })).toBe(true);
  });

  it('a playing player only drops out after a real stall', () => {
    const playing = { ...view, paused: false, readyState: 3, bufferedAhead: 1 };
    expect(nextReady(true, playing)).toBe(true);
    expect(nextReady(true, { ...playing, buffering: true, stalledMs: STALL_GRACE_MS - 1 })).toBe(true);
    expect(nextReady(true, { ...playing, buffering: true, stalledMs: STALL_GRACE_MS })).toBe(false);
  });

  it('once out it needs the real buffer again', () => {
    expect(nextReady(false, { ...view, paused: false, readyState: 3, bufferedAhead: 1 })).toBe(false);
    expect(nextReady(false, { ...view, paused: false, readyState: 3, bufferedAhead: READY_BUFFER_S })).toBe(true);
  });
});

describe('shouldPullBack', () => {
  const room = stateFromWire({ playingMediaId: 'm', isPlaying: true, position: 100, generatedAtMillis: 1000, version: 1 });
  const player = { currentTime: 95, paused: false, playbackRate: 1, duration: 3600 };

  it('moves the room back to a device that fell behind', () => {
    expect(shouldPullBack(room, player, 1000, PULL_BACK_INTERVAL_MS)).toBe(true);
  });

  it('leaves small offsets and devices ahead to the normal correction', () => {
    expect(shouldPullBack(room, { ...player, currentTime: 99.5 }, 1000, PULL_BACK_INTERVAL_MS)).toBe(false);
    expect(shouldPullBack(room, { ...player, currentTime: 110 }, 1000, PULL_BACK_INTERVAL_MS)).toBe(false);
  });

  it('is limited in how often and how far', () => {
    expect(shouldPullBack(room, player, 1000, PULL_BACK_INTERVAL_MS - 1)).toBe(false);
    expect(shouldPullBack(room, { ...player, currentTime: 100 - MAX_PULL_BACK_S - 1 }, 1000, PULL_BACK_INTERVAL_MS)).toBe(false);
  });

  it('never applies to a stopped player or room', () => {
    expect(shouldPullBack(room, { ...player, paused: true }, 1000, PULL_BACK_INTERVAL_MS)).toBe(false);
    expect(shouldPullBack({ ...room, playing: false }, player, 1000, PULL_BACK_INTERVAL_MS)).toBe(false);
  });
});
