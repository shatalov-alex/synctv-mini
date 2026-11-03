import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./profile', () => ({ buildClientProfile: () => ({ profileVersion: 2 }) }));

import { ApiError, type ApiClient } from '../api/http';
import type { VideoPlayer } from '../player/player';
import { RoomSyncEngine } from './engine';

const T0 = 1_800_000_000_000;

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }
  open() {
    this.readyState = 1;
    if (this.onopen) this.onopen();
  }
  push(msg: unknown) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) });
  }
  updates() {
    return this.sent.filter((m) => m.playbackStateUpdate).map((m) => m.playbackStateUpdate);
  }
}

function fakePlayer() {
  const calls: string[] = [];
  const p = {
    calls,
    currentTime: 0,
    paused: true,
    playbackRate: 1,
    duration: 3600,
    ready: true,
    muted: false,
    currentSource: null as unknown,
    buffering: false,
    listeners: [] as Array<(e: { type: string }) => void>,
    on: (l: (e: { type: string }) => void) => {
      p.listeners.push(l);
      return () => {};
    },
    emit: (type: string) => p.listeners.forEach((l) => l({ type })),
    load: async (source: unknown) => {
      p.currentSource = source;
      calls.push(source ? 'load' : 'unload');
    },
    play: async () => {
      calls.push('play');
      p.paused = false;
      return true;
    },
    pause: () => {
      calls.push('pause');
      p.paused = true;
    },
    seek: (t: number) => {
      calls.push(`seek:${t}`);
      p.currentTime = t;
    },
    setRate: (r: number) => {
      calls.push(`rate:${r}`);
      p.playbackRate = r;
    },
    setMuted: () => {},
  };
  return p;
}

function fakeApi() {
  const requests: Array<{ method: string; path: string }> = [];
  let ticket = 0;
  const api = {
    requests,
    ticketError: null as Error | null,
    request: async (method: string, path: string) => {
      requests.push({ method, path });
      if (path === '/api/tickets') {
        if (api.ticketError) throw api.ticketError;
        return { ticket: `t${++ticket}` };
      }
      if (path === '/api/public/time') throw new Error('offline'); // offset stays 0
      return {};
    },
  };
  return api;
}

const playback = { mediaId: 'med_1', name: 'Film', playbackInfos: { direct: { medias: [{ url: 'https://x/a.mp4' }] } } };
const state = (over: Record<string, unknown> = {}) => ({
  playingMediaId: 'med_1',
  isPlaying: true,
  position: 50,
  speed: 1,
  version: '1',
  generatedAtMillis: String(Date.now()),
  ...over,
});
const stateEvent = (s: unknown) => ({ resourceEvent: { observeId: 'playback_state', playbackState: s } });
const playbackEvent = (pb: unknown) => ({ resourceEvent: { observeId: 'playback', playback: pb } });

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function setup() {
  const player = fakePlayer();
  const api = fakeApi();
  const engine = new RoomSyncEngine(api as unknown as ApiClient, player as unknown as VideoPlayer, {
    origin: 'https://tv.example',
  });
  engine.connect('room_1');
  await flush();
  const ws = FakeWS.all[FakeWS.all.length - 1];
  ws.open();
  return { player, api, engine, ws };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  FakeWS.all = [];
  (globalThis as any).WebSocket = FakeWS;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('RoomSyncEngine', () => {
  it('connects with a fresh ticket and subscribes to playback_state and playback', async () => {
    const { ws, api } = await setup();
    expect(ws.url).toBe('wss://tv.example/ws/rooms/room_1?ticket=t1&format=json');
    expect(api.requests.filter((r) => r.path === '/api/tickets')).toHaveLength(1);
    expect(ws.sent.map((m) => m.observeResource && m.observeResource.observeId)).toEqual(['playback_state', 'playback']);
    expect(ws.sent[1].observeResource.deliveryMode).toBe(2);
  });

  it('initial join: loads the source, force-syncs (0.2 s threshold) and plays; tolerates playback-first order', async () => {
    const { ws, player } = await setup();
    ws.push(playbackEvent(playback));
    ws.push(stateEvent(state()));
    await flush();
    expect(player.calls).toEqual(['load', 'seek:50', 'play']);
  });

  it('state-first order also works', async () => {
    const { ws, player } = await setup();
    ws.push(stateEvent(state()));
    await flush();
    expect(player.calls).toEqual([]);
    ws.push(playbackEvent(playback));
    await flush();
    expect(player.calls).toEqual(['load', 'seek:50', 'play']);
  });

  it('remote seeks under 1.2 s are ignored; larger ones hard-seek', async () => {
    const { ws, player } = await setup();
    ws.push(playbackEvent(playback));
    ws.push(stateEvent(state()));
    await flush();
    player.calls.length = 0;
    ws.push(stateEvent(state({ position: 51, version: '2' })));
    await flush();
    expect(player.calls).toEqual([]);
    ws.push(stateEvent(state({ position: 80, version: '3' })));
    await flush();
    expect(player.calls).toEqual(['seek:80']);
  });

  it('drops older versions', async () => {
    const { ws, player } = await setup();
    ws.push(playbackEvent(playback));
    ws.push(stateEvent(state({ version: '5' })));
    await flush();
    player.calls.length = 0;
    ws.push(stateEvent(state({ version: '4', isPlaying: false, position: 10 })));
    await flush();
    expect(player.calls).toEqual([]);
  });

  it('user gestures apply locally, send one command, and our own ack does not touch the player', async () => {
    const { ws, player, engine } = await setup();
    ws.push(playbackEvent(playback));
    ws.push(stateEvent(state()));
    await flush();
    player.calls.length = 0;
    vi.setSystemTime(T0 + 1000);
    engine.pause();
    expect(player.calls).toEqual(['pause']);
    const [cmd] = ws.updates();
    expect(cmd).toMatchObject({ type: 2, playing: false, position: 50, expectedMediaId: 'med_1', clientTimeMillis: String(T0 + 1000) });
    expect(cmd.clientOperationId).toMatch(/^[0-9a-f-]{36}$/);
    // Server ack with our op id and a slightly different position: stored, player untouched.
    ws.push(stateEvent(state({ isPlaying: false, position: 50.5, version: '2', clientOperationId: cmd.clientOperationId })));
    await flush();
    expect(player.calls).toEqual(['pause']);
    expect(engine.snapshot().state!.position).toBe(50.5);
  });

  it('player events never send anything', async () => {
    const { ws, player } = await setup();
    ws.push(playbackEvent(playback));
    ws.push(stateEvent(state()));
    await flush();
    player.pause();
    player.seek(10);
    expect(ws.updates()).toEqual([]);
  });

  it('rolls back a rejected command with a forced sync and surfaces the error', async () => {
    const { ws, player, engine } = await setup();
    ws.push(playbackEvent(playback));
    ws.push(stateEvent(state({ generatedAtMillis: String(T0) })));
    await flush();
    player.calls.length = 0;
    engine.seek(300);
    const [cmd] = ws.updates();
    expect(cmd).toMatchObject({ type: 3, position: 300, playing: true });
    ws.push({ error: { code: 7, message: 'No permission', clientOperationId: cmd.clientOperationId } });
    await flush();
    expect(player.calls).toEqual(['seek:300', 'seek:50']);
    expect(engine.snapshot().error).toBe('No permission');
  });

  it('conflict errors (2003) roll back silently', async () => {
    const { ws, engine } = await setup();
    ws.push(playbackEvent(playback));
    ws.push(stateEvent(state()));
    await flush();
    engine.seek(300);
    const [cmd] = ws.updates();
    ws.push({ error: { code: 2003, message: 'conflict', clientOperationId: cmd.clientOperationId } });
    await flush();
    expect(engine.snapshot().error).toBeNull();
  });

  it('the 2 s loop corrects drift but not during the 800 ms cooldown', async () => {
    const { ws, player } = await setup();
    ws.push(playbackEvent(playback));
    vi.setSystemTime(T0 + 1700);
    ws.push(stateEvent(state({ generatedAtMillis: String(T0 + 1700) })));
    await flush();
    player.calls.length = 0;
    player.paused = true; // e.g. the OS paused us
    await vi.advanceTimersByTimeAsync(300); // loop tick at T0+2000: still cooling down
    expect(player.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000); // next tick at T0+4000
    expect(player.calls).toContain('play');
  });

  it('a stalled player is hard-seeked forward once it falls > 1.2 s behind', async () => {
    const { ws, player } = await setup();
    ws.push(playbackEvent(playback));
    ws.push(stateEvent(state({ generatedAtMillis: String(T0) })));
    await flush();
    player.calls.length = 0;
    // currentTime frozen at 50 (buffering) while the room advances
    await vi.advanceTimersByTimeAsync(2000);
    expect(player.calls).toEqual(['seek:52']);
  });

  it('reconnects with backoff and a new ticket, then resubscribes', async () => {
    const { ws, api } = await setup();
    ws.close();
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeWS.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(FakeWS.all).toHaveLength(2);
    expect(FakeWS.all[1].url).toContain('ticket=t2');
    FakeWS.all[1].open();
    expect(FakeWS.all[1].sent.filter((m) => m.observeResource)).toHaveLength(2);
    expect(api.requests.filter((r) => r.path === '/api/tickets')).toHaveLength(2);
  });

  it('sends a heartbeat every 25 s', async () => {
    const { ws } = await setup();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(ws.sent.filter((m) => m.heartbeat)).toEqual([{ heartbeat: { timestamp: String(T0 + 25_000) } }]);
  });

  it('kicked with a membership-revoked termination: access lost, no reconnect', async () => {
    const { ws, engine } = await setup();
    ws.push({ termination: { message: 'Removed from room', code: 4 } });
    ws.close();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(engine.snapshot().accessLost).toBe('Removed from room');
    expect(engine.snapshot().connection).toBe('closed');
    expect(FakeWS.all).toHaveLength(1);
  });

  it('a 403 ticket on reconnect (no longer a member) is access loss', async () => {
    const { ws, api, engine } = await setup();
    api.ticketError = new ApiError(403, 'Not a member of this room. Join the room first.');
    ws.close();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(engine.snapshot().accessLost).toMatch(/Not a member/);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.requests.filter((r) => r.path === '/api/tickets')).toHaveLength(2);
  });

  it('network errors on the ticket keep retrying', async () => {
    const { ws, api, engine } = await setup();
    api.ticketError = new Error('offline');
    ws.close();
    await vi.advanceTimersByTimeAsync(2000 + 4000);
    await flush();
    expect(engine.snapshot().accessLost).toBeNull();
    expect(api.requests.filter((r) => r.path === '/api/tickets').length).toBeGreaterThanOrEqual(3);
  });
});

describe('RoomSyncEngine on phones (backgrounding)', () => {
  let doc: EventTarget & { visibilityState: string };
  beforeEach(() => {
    doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', new EventTarget());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const setVisibility = (value: string) => {
    doc.visibilityState = value;
    doc.dispatchEvent(new Event('visibilitychange'));
  };

  it('reconnects right away on return instead of waiting out the backoff', async () => {
    const { ws } = await setup();
    setVisibility('hidden');
    ws.close(); // the OS killed the socket in the background
    expect(FakeWS.all).toHaveLength(1); // backoff timer pending
    setVisibility('visible');
    await flush();
    expect(FakeWS.all).toHaveLength(2);
  });

  it('replaces a socket that still claims OPEN after a long background', async () => {
    const { ws } = await setup();
    setVisibility('hidden');
    vi.setSystemTime(T0 + 60_000);
    setVisibility('visible');
    await flush();
    expect(FakeWS.all).toHaveLength(2);
    expect(ws.readyState).toBe(3);
    // A short hide keeps the live socket.
    FakeWS.all[1].open();
    setVisibility('hidden');
    vi.setSystemTime(T0 + 65_000);
    setVisibility('visible');
    await flush();
    expect(FakeWS.all).toHaveLength(2);
  });

  it('overlapping connects open only one socket', async () => {
    const { ws } = await setup();
    ws.close();
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('online'));
    await flush();
    expect(FakeWS.all.filter((w) => w.readyState !== 3)).toHaveLength(1);
  });

  it('stops listening once disposed', async () => {
    const { ws, engine } = await setup();
    engine.dispose();
    ws.close();
    setVisibility('hidden');
    vi.setSystemTime(T0 + 60_000);
    setVisibility('visible');
    await flush();
    expect(FakeWS.all).toHaveLength(1);
  });
});

describe('RoomSyncEngine post-start settle', () => {
  it('re-syncs once after a forced seek+play starts late, then stops', async () => {
    const { ws, player } = await setup();
    ws.push(playbackEvent(playback));
    ws.push(stateEvent(state()));
    await flush();
    expect(player.calls).toEqual(['load', 'seek:50', 'play']);
    player.calls.length = 0;
    // Buffering ate 0.8 s; when measured (1 s later) the room is at 51.8, the player at 51.
    vi.setSystemTime(T0 + 800);
    player.emit('playing');
    player.currentTime = 51;
    await vi.advanceTimersByTimeAsync(1000);
    expect(player.calls).toEqual(['seek:51.8']);
    // A later stall/restart does not trigger another settle.
    player.calls.length = 0;
    player.currentTime = 52; // room at 52.8 a second later: 0.8 s off again
    player.emit('playing');
    await vi.advanceTimersByTimeAsync(1000);
    expect(player.calls).toEqual([]);
  });

  it('leaves small drift alone', async () => {
    const { ws, player } = await setup();
    ws.push(playbackEvent(playback));
    ws.push(stateEvent(state()));
    await flush();
    player.calls.length = 0;
    vi.setSystemTime(T0 + 100);
    player.emit('playing');
    player.currentTime = 51; // room at 51.1 when measured
    await vi.advanceTimersByTimeAsync(1000);
    expect(player.calls).toEqual([]);
  });
});

describe('RoomSyncEngine precise sync while paused', () => {
  it('a paused room lines up within 0.2 s, and the following start keeps it', async () => {
    const { ws, player } = await setup();
    ws.push(playbackEvent(playback));
    ws.push(stateEvent(state({ isPlaying: false, position: 0 })));
    await flush();
    player.calls.length = 0;
    player.currentTime = 1.0; // under the 1.2 s auto-seek threshold
    ws.push(stateEvent(state({ isPlaying: false, position: 0, version: '2' })));
    await flush();
    expect(player.calls).toEqual(['seek:0']);
    player.calls.length = 0;
    player.currentTime = 0.5;
    ws.push(stateEvent(state({ isPlaying: true, position: 0, version: '3' })));
    await flush();
    expect(player.calls).toEqual(['seek:0', 'play']);
  });
});
