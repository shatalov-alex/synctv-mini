import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError } from './http';
import { TokenStore } from './session';
import {
  claimErrorMessage,
  claimPairing,
  normalizeCode,
  normalizeStatus,
  parseDevices,
  parseExpiry,
  parsePairing,
  parsePoll,
  pollRetryDelayMs,
  revokeTvDevice,
  startRetryDelayMs,
} from './tv';

describe('tv pairing parsing (served pbjson shapes)', () => {
  it('parses a start response with int64-as-string expiry', () => {
    expect(
      parsePairing({ code: 'K7MXQ4', pairingSecret: 's'.repeat(43), expiresAt: '1762190000', pollIntervalMs: 2000 }, 0),
    ).toEqual({ code: 'K7MXQ4', pairingSecret: 's'.repeat(43), expiresAtMs: 1_762_190_000_000, pollIntervalMs: 2000 });
  });

  it('defaults and clamps the poll interval and expiry', () => {
    const now = 1_800_000_000_000;
    expect(parsePairing({ code: 'A', pairingSecret: 's', pollIntervalMs: 50 }, now)).toMatchObject({
      pollIntervalMs: 1000,
      expiresAtMs: now + 300_000,
    });
    expect(parsePairing({ code: 'A', pairingSecret: 's' }, now).pollIntervalMs).toBe(2000);
    expect(() => parsePairing({ code: 'A' }, now)).toThrow();
    expect(parseExpiry(1_800_000_300_000, now)).toBe(1_800_000_300_000);
  });

  it('maps plain status strings', () => {
    expect(normalizeStatus('PENDING')).toBe('pending');
    expect(normalizeStatus('CLAIMED')).toBe('claimed');
    expect(normalizeStatus('EXPIRED')).toBe('expired');
    expect(normalizeStatus('pending')).toBe('pending');
    expect(normalizeStatus(undefined)).toBe('unknown');
  });

  it('parses poll responses; empty fields are omitted while pending/expired', () => {
    expect(parsePoll({ status: 'PENDING' })).toEqual({ status: 'pending' });
    expect(parsePoll({ status: 'EXPIRED' })).toEqual({ status: 'expired' });
    expect(parsePoll({})).toEqual({ status: 'expired' });
    expect(
      parsePoll({ status: 'CLAIMED', roomId: 'room_1', login: { user: { id: 'tv_1' }, accessToken: 'a', refreshToken: 'r' } }),
    ).toEqual({ status: 'claimed', roomId: 'room_1', tokens: { accessToken: 'a', refreshToken: 'r' } });
    expect(parsePoll({ status: 'CLAIMED', roomId: 'room_1' })).toEqual({ status: 'expired' });
  });

  it('parses the paired TV list', () => {
    expect(
      parseDevices({
        tvs: [
          { userId: 'tv_1', name: 'Living room', pairedAt: '1762190000', pairedBy: 'usr_a' },
          { userId: 'tv_2', pairedAt: '1762190001' },
          { name: 'no id' },
        ],
      }),
    ).toEqual([
      { userId: 'tv_1', name: 'Living room', pairedAt: 1762190000, pairedBy: 'usr_a' },
      { userId: 'tv_2', name: 'TV', pairedAt: 1762190001, pairedBy: '' },
    ]);
    expect(parseDevices({})).toEqual([]);
  });

  it('gives distinct claim error messages', () => {
    const msg = (status: number) => claimErrorMessage(new ApiError(status, 'x'));
    expect(msg(404)).toMatch(/wrong or has expired/);
    expect(msg(403)).toMatch(/playback control/);
    expect(msg(401)).toMatch(/Too many wrong codes/);
    expect(msg(429)).toMatch(/Too many attempts/);
    expect(new Set([msg(404), msg(403), msg(401), msg(429)]).size).toBe(4);
    expect(claimErrorMessage(new TypeError('fetch'))).toMatch(/Network/);
  });

  it('backs off on 429', () => {
    expect(startRetryDelayMs(new ApiError(429, ''))).toBe(65_000);
    expect(startRetryDelayMs(new Error('net'))).toBe(5_000);
    expect(pollRetryDelayMs(new ApiError(429, ''), 2000)).toBe(30_000);
    expect(pollRetryDelayMs(new Error('net'), 2000)).toBe(3000);
  });

  it('normalizes typed codes', () => {
    expect(normalizeCode(' k7m-xq4 ')).toBe('K7MXQ4');
  });
});

describe('tv pairing requests', () => {
  function client(status: number, body: unknown) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const store = new TokenStore('t');
    store.set({ accessToken: 'acc', refreshToken: 'ref' });
    const api = new ApiClient({
      store,
      fetch: async (url, init = {}) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body), { status });
      },
    });
    return { api, calls };
  }

  it('claim sends only {code, roomId} and does not refresh-and-retry a lockout 401', async () => {
    const { api, calls } = client(401, { code: 16, message: 'locked' });
    await expect(claimPairing(api, 'K7MXQ4', 'room_1')).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ code: 'K7MXQ4', roomId: 'room_1' });
  });

  it('revoke posts with no body', async () => {
    const { api, calls } = client(200, {});
    await revokeTvDevice(api, 'room_1', 'tv_1');
    expect(calls[0].url).toBe('/api/rooms/room_1/tvs/tv_1/revoke');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBeUndefined();
  });
});
