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
    seeking: false,
    readyState: 4,
    bufferedAhead: 30,
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
    setPreload: () => {},
  };
  return p;
}

function fakeApi() {
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  let ticket = 0;
  const api = {
    requests,
    ticketError: null as Error | null,
    request: async (method: string, path: string, body?: unknown) => {
      requests.push({ method, path, body });
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

async function setup(options: { roomDetails?: boolean; roomSettings?: boolean } = {}) {
  const player = fakePlayer();
  const api = fakeApi();
  const engine = new RoomSyncEngine(api as unknown as ApiClient, player as unknown as VideoPlayer, {
    origin: 'https://tv.example',
    ...options,
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

  it('observes room details only when asked to, again on every connect', async () => {
    const { ws, engine } = await setup({ roomDetails: true });
    expect(ws.sent.map((m) => m.observeResource.observeId)).toEqual([
      'playback_state',
      'playback',
      'playlist_items',
      'room_members',
      'room_online',
      'room_settings',
    ]);
    expect(ws.sent[2].observeResource).toMatchObject({ deliveryMode: 2, playlistItems: { request: { pageSize: 100 } } });
    expect(engine.snapshot().playlist).toBeNull();
    ws.close();
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    FakeWS.all[1].open();
    expect(FakeWS.all[1].sent.map((m) => m.observeResource?.observeId)).toContain('playlist_items');
  });

  it("gives a TV the room's settings and nothing else of the room's details", async () => {
    const { ws, engine } = await setup({ roomSettings: true });
    expect(ws.sent.map((m) => m.observeResource.observeId)).toEqual(['playback_state', 'playback', 'room_settings']);
    expect(engine.snapshot().tvSubtitles).toBeNull();
    const push = (settings: object) => ws.push({ resourceEvent: { observeId: 'room_settings', roomSettings: { settings } } });
    push({ tvSubtitles: { enabled: true, track: 'en|English' } });
    expect(engine.snapshot().tvSubtitles).toEqual({ enabled: true, track: 'en|English' });
    // On the wire, false and "" are left out.
    push({ tvSubtitles: {} });
    expect(engine.snapshot().tvSubtitles).toEqual({ enabled: false, track: '' });
    // Settings from before this field existed.
    push({});
    expect(engine.snapshot().tvSubtitles).toEqual({ enabled: true, track: '' });
  });

  it('keeps the pushed playlist in the snapshot, including an emptied one', async () => {
    const { ws, engine, player } = await setup({ roomDetails: true });
    const seen: unknown[] = [];
    engine.onState((s) => seen.push(s.playlist));
    ws.push({ resourceEvent: { observeId: 'playlist_items', playlistItems: { media: [{ id: 'a' }, { id: 'b' }] } } });
    expect(engine.snapshot().playlist).toEqual([{ id: 'a' }, { id: 'b' }]);
    ws.push({ resourceEvent: { observeId: 'playlist_items', playlistItems: {} } });
    expect(engine.snapshot().playlist).toEqual([]);
    ws.push({ resourceEvent: { observeId: 'playlist_items' } });
    expect(engine.snapshot().playlist).toEqual([]);
    expect(seen[seen.length - 1]).toEqual([]);
    expect(player.calls).toEqual([]);
  });

  it('next and previous follow the room autoplay setting', async () => {
    const { ws, engine, api } = await setup({ roomDetails: true });
    const bodies = () =>
      api.requests.filter((r: any) => /playback\/(next|previous)$/.test(r.path)).map((r: any) => [r.path.split('/').pop(), r.body]);
    await engine.next(); // not known yet: stays paused
    ws.push({ resourceEvent: { observeId: 'room_settings', roomSettings: { settings: { autoPlay: { enabled: true } } } } });
    expect(engine.snapshot().autoPlay).toBe(true);
    await engine.next();
    ws.push({ resourceEvent: { observeId: 'room_settings', roomSettings: { settings: {} } } });
    expect(engine.snapshot().autoPlay).toBe(false);
    await engine.prev();
    expect(bodies()).toEqual([
      ['next', { playing: false }],
      ['next', { playing: true }],
      ['previous', { playing: false }],
    ]);
  });

  it('counts member changes', async () => {
    const { ws, engine } = await setup({ roomDetails: true });
    ws.push({ resourceEvent: { observeId: 'room_members', roomMemberEvent: { kind: 4 } } });
    ws.push({ resourceEvent: { observeId: 'room_members', roomMemberEvent: { kind: 1 } } });
    expect(engine.snapshot().memberChanges).toBe(2);
    ws.push({ resourceEvent: { observeId: 'room_online', onlineEvent: { kind: 1, userId: 'usr_tv' } } });
    expect(engine.snapshot().memberChanges).toBe(3);
    ws.push({ resourceEvent: { observeId: 'room_online', onlineEvent: { kind: 2, userId: 'usr_tv' } } });
    expect(engine.snapshot().memberChanges).toBe(3);
  });

  it('a refused playlist observation leaves the playlist unknown', async () => {
    const { ws, engine } = await setup({ roomDetails: true });
    ws.push({ resourceObserveError: { observeId: 'playlist_items', error: { code: 7, message: 'Guests cannot observe playlist items' } } });
    expect(engine.snapshot().playlist).toBeNull();
    expect(engine.snapshot().error).toBeNull();
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

describe('RoomSyncEngine playback errors', () => {
  it('reloads with a freshly signed URL (expired proxy signature)', async () => {
    const { ws, player, api } = await setup();
    const signed = (sig: string) => ({ ...playback, playbackInfos: { proxy: { medias: [{ url: `https://srv/stream?sig=${sig}` }] } } });
    ws.push(playbackEvent(signed('old')));
    ws.push(stateEvent(state()));
    await flush();
    const original = api.request;
    (api as any).request = async (method: string, path: string) => {
      if (path === '/api/rooms/room_1/playback') return { playback: signed('new') };
      return original(method, path);
    };
    player.calls.length = 0;
    player.emit('error');
    await flush();
    expect((player.currentSource as { url: string }).url).toBe('https://srv/stream?sig=new');
    expect(player.calls[0]).toBe('load');
  });

  it('falls back to the old URL when the refresh fails', async () => {
    const { ws, player } = await setup();
    ws.push(playbackEvent(playback));
    ws.push(stateEvent(state()));
    await flush();
    player.calls.length = 0;
    player.emit('error'); // fakeApi answers {} for /playback
    await flush();
    expect((player.currentSource as { url: string }).url).toBe('https://x/a.mp4');
    expect(player.calls[0]).toBe('load');
  });
});

describe('RoomSyncEngine replaced links', () => {
  it('a new link recovers a player that gave up, at the room position', async () => {
    const { ws, player, api, engine } = await setup();
    ws.push(playbackEvent(playback));
    ws.push(stateEvent(state({ generatedAtMillis: String(T0) })));
    await flush();
    (api as any).request = async () => ({ playback });
    for (let i = 0; i < 4; i++) {
      player.emit('error');
      await flush();
    }
    expect(engine.snapshot().error).toBe('Playback error');
    player.calls.length = 0;
    player.currentTime = 0;

    const relinked = { ...playback, playbackInfos: { direct: { medias: [{ url: 'https://cdn/new.mp4' }] } } };
    ws.push(playbackEvent(relinked));
    await flush();

    expect(engine.snapshot().error).toBeNull();
    expect(player.calls).toEqual(expect.arrayContaining(['load', 'seek:50']));
    expect((player.currentSource as { url: string }).url).toBe('https://cdn/new.mp4');
  });

  it('a new link does not interrupt a player that is still working', async () => {
    const { ws, player } = await setup();
    ws.push(playbackEvent(playback));
    ws.push(stateEvent(state({ generatedAtMillis: String(T0) })));
    await flush();
    player.calls.length = 0;
    const relinked = { ...playback, playbackInfos: { direct: { medias: [{ url: 'https://cdn/new.mp4' }] } } };
    ws.push(playbackEvent(relinked));
    await flush();
    expect(player.calls).not.toContain('load');
  });

  it('errors far apart each get their own reload budget', async () => {
    const { ws, player, api, engine } = await setup();
    ws.push(playbackEvent(playback));
    ws.push(stateEvent(state({ generatedAtMillis: String(T0) })));
    await flush();
    (api as any).request = async () => ({ playback });
    for (let i = 0; i < 5; i++) {
      player.emit('error');
      await flush();
      await vi.advanceTimersByTimeAsync(61_000);
    }
    expect(engine.snapshot().error).toBeNull();
  });
});

describe('RoomSyncEngine duration reporting', () => {
  const reports = (api: ReturnType<typeof fakeApi>) => api.requests.filter((r) => r.path.endsWith('/duration'));

  it('reports the player duration once per media when the server has none', async () => {
    const { ws, api, player } = await setup();
    player.duration = 1234.5;
    ws.push(playbackEvent(playback));
    ws.push(stateEvent(state()));
    await flush();
    expect(reports(api)).toEqual([
      { method: 'PUT', path: '/api/rooms/room_1/media/med_1/duration', body: { durationSeconds: 1234.5 } },
    ]);

    // Reloading the same media (error recovery, new signed URL) does not report again.
    player.emit('error');
    await flush();
    ws.push(playbackEvent({ ...playback, playbackInfos: { direct: { medias: [{ url: 'https://x/b.mp4' }] } } }));
    await flush();
    expect(reports(api)).toHaveLength(1);
  });

  it('a failed report is not retried', async () => {
    const { ws, api, player } = await setup();
    const original = api.request;
    (api as any).request = async (method: string, path: string, body?: unknown) => {
      if (path.endsWith('/duration')) {
        api.requests.push({ method, path, body });
        throw new ApiError(403, 'forbidden');
      }
      return original(method, path, body);
    };
    ws.push(playbackEvent(playback));
    ws.push(stateEvent(state()));
    await flush();
    vi.advanceTimersByTime(10_000);
    await flush();
    expect(reports(api)).toHaveLength(1);
    expect(player.calls.slice(0, 3)).toEqual(['load', 'seek:50', 'play']); // playback unaffected
  });

  it('skips media whose duration is known, live sources and unknown player durations', async () => {
    const known = await setup();
    known.ws.push(playbackEvent({ ...playback, durationSeconds: 60 }));
    known.ws.push(stateEvent(state()));
    await flush();
    expect(reports(known.api)).toEqual([]);

    const live = await setup();
    live.ws.push(playbackEvent({ ...playback, playbackKind: 2 }));
    live.ws.push(stateEvent(state()));
    await flush();
    expect(reports(live.api)).toEqual([]);

    const unknown = await setup();
    unknown.player.duration = Infinity; // e.g. a stream without an end
    unknown.ws.push(playbackEvent(playback));
    unknown.ws.push(stateEvent(state()));
    await flush();
    expect(reports(unknown.api)).toEqual([]);
  });
});

describe('RoomSyncEngine remote mode (a paired TV plays, the phone controls)', () => {
  async function setupRemote() {
    const player = fakePlayer();
    const api = fakeApi();
    const engine = new RoomSyncEngine(api as unknown as ApiClient, player as unknown as VideoPlayer, {
      origin: 'https://tv.example',
      remote: true,
    });
    engine.connect('room_1');
    await flush();
    const ws = FakeWS.all[FakeWS.all.length - 1];
    ws.open();
    ws.push(playbackEvent(playback));
    ws.push(stateEvent(state()));
    await flush();
    return { player, api, engine, ws };
  }
  const played = (calls: string[]) => calls.filter((c) => c === 'play' || c.startsWith('seek'));

  it('never plays or seeks locally, even through the 2 s loop', async () => {
    const { player, engine } = await setupRemote();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(played(player.calls)).toEqual([]);
    expect(player.calls).toContain('load'); // metadata only, for the duration
    expect(engine.snapshot().remote).toBe(true);
  });

  it('positions come from the room clock; commands carry them', async () => {
    const { player, engine, ws } = await setupRemote();
    vi.setSystemTime(T0 + 4000);
    expect(engine.position()).toBeCloseTo(54, 1);
    engine.pause();
    const [pause] = ws.updates();
    expect(pause).toMatchObject({ type: 2, playing: false });
    expect(pause.position).toBeCloseTo(54, 1);
    engine.seek(engine.position() + 10);
    expect(ws.updates()[1].position).toBeCloseTo(64, 1);
    engine.play();
    expect(ws.updates()[2]).toMatchObject({ playing: true });
    expect(played(player.calls)).toEqual([]);
  });

  it('switching to "watch here" starts the phone in sync', async () => {
    const { player, engine } = await setupRemote();
    vi.setSystemTime(T0 + 3000);
    player.calls.length = 0;
    engine.setRemote(false);
    await flush();
    expect(player.calls).toEqual(['seek:53', 'play']);
    engine.setRemote(true);
    expect(player.paused).toBe(true);
  });
});

describe('RoomSyncEngine device status', () => {
  afterEach(() => vi.useRealTimers());
  const statuses = (ws: FakeWS) => ws.sent.filter((m) => m.playerStatus).map((m) => m.playerStatus);
  const last = (ws: FakeWS) => statuses(ws)[statuses(ws).length - 1];

  async function ready() {
    const ctx = await setup();
    const pushAll = async (over: { playing: boolean; position: number }) => {
      ctx.ws.push(playbackEvent(playback));
      ctx.ws.push(stateEvent(state({ isPlaying: over.playing, position: over.position })));
      await flush();
    };
    return { ...ctx, pushAll };
  }

  it('reports not ready until the video has loaded enough, then ready', async () => {
    const { ws, player, pushAll } = await ready();
    player.readyState = 1;
    player.bufferedAhead = 0;
    await pushAll({ playing: false, position: 10 });
    await vi.advanceTimersByTimeAsync(2100);
    expect(last(ws)).toMatchObject({ participating: true, ready: false, mediaId: playback.mediaId });
    player.readyState = 4;
    await vi.advanceTimersByTimeAsync(2100);
    expect(last(ws)).toMatchObject({ participating: true, ready: true, mediaId: playback.mediaId });
  });

  it('does not count as a player in remote mode', async () => {
    const { ws, engine, pushAll } = await ready();
    await pushAll({ playing: false, position: 10 });
    engine.setRemote(true);
    await vi.advanceTimersByTimeAsync(2100);
    expect(last(ws)).toMatchObject({ participating: false });
  });

  it('shows how many devices the room waits for, only while it is held', async () => {
    const { ws, engine } = await ready();
    ws.push({ playbackGate: { waitingDevices: 2, holding: true } });
    expect(engine.snapshot().waitingDevices).toBe(2);
    ws.push({ playbackGate: { waitingDevices: 1 } });
    expect(engine.snapshot().waitingDevices).toBe(0);
  });

  it('moves the room back when it falls behind instead of jumping ahead', async () => {
    const { ws, player, pushAll } = await ready();
    await pushAll({ playing: true, position: 100 });
    await vi.advanceTimersByTimeAsync(900); // past the sync cooldown
    player.currentTime = 102; // keeping up with the room at the next check
    await vi.advanceTimersByTimeAsync(1100);
    player.currentTime = 94; // a stall the player has just come out of
    player.calls.length = 0;
    await vi.advanceTimersByTimeAsync(2000);
    expect(player.calls.filter((c: string) => c.startsWith('seek'))).toEqual([]);
    expect(last(ws)).toMatchObject({ ready: false });
    expect(last(ws).position).toBeCloseTo(player.currentTime, 1);
  });

  it('a device that just joined jumps to the room and moves nobody', async () => {
    const { ws, player, pushAll } = await ready();
    player.currentTime = 0;
    await pushAll({ playing: true, position: 100 });
    expect(player.currentTime).toBeGreaterThan(99);
    const positions = statuses(ws).map((s: { position?: number }) => s.position).filter((p: number | undefined) => p !== undefined);
    expect(positions.every((p: number) => p > 99)).toBe(true);
  });

  it('reports a stall only after the grace period', async () => {
    const { ws, player, pushAll } = await ready();
    await pushAll({ playing: true, position: 100 });
    await vi.advanceTimersByTimeAsync(2100);
    player.buffering = true;
    player.emit('waiting');
    await vi.advanceTimersByTimeAsync(500);
    expect(last(ws)).toMatchObject({ ready: true });
    await vi.advanceTimersByTimeAsync(600);
    expect(last(ws)).toMatchObject({ ready: false });
  });

  it('reports a new room state at once, without the position from before it', async () => {
    const { ws, player, pushAll } = await ready();
    await pushAll({ playing: true, position: 100 });
    await vi.advanceTimersByTimeAsync(900);
    player.currentTime = 101; // keeping up, with the position counted
    await vi.advanceTimersByTimeAsync(1100);
    expect(last(ws).position).toBeDefined();
    const before = statuses(ws).length;
    player.seek = () => {}; // the seek hasn't happened yet
    ws.push(stateEvent(state({ isPlaying: true, position: 300, version: '2' })));
    const first = statuses(ws)[before];
    expect(first).toMatchObject({ stateVersion: '2' });
    expect(first.position).toBeUndefined();
  });

  it('keeps waiting for a video slower than the load timeout, then syncs', async () => {
    const { ws, player } = await setup();
    player.ready = false;
    ws.push(playbackEvent(playback));
    ws.push(stateEvent(state({ isPlaying: true, position: 50 })));
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(player.calls).toEqual(['load']);
    player.ready = true;
    player.emit('loadedmetadata');
    await vi.advanceTimersByTimeAsync(10);
    expect(player.calls).toContain('play');
  });

  async function playingAt100() {
    const ctx = await ready();
    await ctx.pushAll({ playing: true, position: 100 });
    await vi.advanceTimersByTimeAsync(900);
    ctx.player.currentTime = 101;
    await vi.advanceTimersByTimeAsync(1100);
    return ctx;
  }

  it('a room seek to an unbuffered part reports not ready at once', async () => {
    const { ws, player } = await playingAt100();
    player.bufferedAhead = 0;
    player.readyState = 1;
    ws.push(stateEvent(state({ isPlaying: true, position: 500, version: '2' })));
    await flush();
    expect(last(ws)).toMatchObject({ ready: false, stateVersion: '2' });
    player.readyState = 4;
    await vi.advanceTimersByTimeAsync(900);
    player.currentTime = 502; // keeping up with the room at the next check
    await vi.advanceTimersByTimeAsync(1100);
    expect(last(ws)).toMatchObject({ ready: true });
  });

  it('its own seek to an unbuffered part reports not ready at once', async () => {
    const { ws, player, engine } = await playingAt100();
    player.bufferedAhead = 0;
    player.seeking = true; // a browser reports this as soon as the seek starts
    engine.seek(500);
    expect(last(ws)).toMatchObject({ ready: false });
  });

  it('a seek inside the buffer holds nobody', async () => {
    const { ws, player } = await playingAt100();
    player.bufferedAhead = 20;
    ws.push(stateEvent(state({ isPlaying: true, position: 110, version: '2' })));
    await flush();
    expect(last(ws)).toMatchObject({ ready: true });
  });

  it('a small correction holds nobody, even with little buffered', async () => {
    const { ws, player } = await playingAt100();
    player.bufferedAhead = 1;
    player.readyState = 3;
    ws.push(stateEvent(state({ isPlaying: true, position: player.currentTime + 0.5, version: '2' })));
    await flush();
    expect(last(ws)).toMatchObject({ ready: true });
  });
});
