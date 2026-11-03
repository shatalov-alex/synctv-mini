// TV pairing API (synctv-api-http/src/http/tv_pairing.rs, client.proto
// StartTvPairing* / PollTvPairing* / ClaimTvPairing* / TvDevice). Served as
// pbjson: int64 as strings, defaults omitted. Wire details live only here.
import { ApiError, type ApiClient } from './http';
import type { Tokens } from './session';
import { tokensFromLogin } from './endpoints';
import { toNumber, type Int64, type LoginResponse } from './types';

export interface TvPairing {
  code: string;
  pairingSecret: string;
  /** Unix milliseconds. */
  expiresAtMs: number;
  pollIntervalMs: number;
}

export type TvPollResult =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'claimed'; tokens: Tokens; roomId: string };

export interface TvDevice {
  userId: string;
  name: string;
  /** Unix seconds; 0 if unknown. */
  pairedAt: number;
  /** Claimer's user id; '' if that account is gone. */
  pairedBy: string;
}

interface RawPairing {
  code?: string;
  pairingSecret?: string;
  expiresAt?: Int64;
  pollIntervalMs?: Int64;
}

interface RawPoll {
  status?: string | number;
  login?: LoginResponse;
  roomId?: string;
}

interface RawDevice {
  userId?: string;
  name?: string;
  pairedAt?: Int64;
  pairedBy?: string;
}

const DEFAULT_POLL_MS = 2000;
/** Pairings live 5 minutes server-side. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Unix seconds (the served format) or milliseconds; a missing value means the default TTL. */
export function parseExpiry(value: Int64 | undefined, nowMs: number): number {
  const n = toNumber(value, 0);
  if (n <= 0) return nowMs + DEFAULT_TTL_MS;
  return n < 1e12 ? n * 1000 : n;
}

/** Server sends "PENDING" | "CLAIMED" | "EXPIRED"; tolerate case and enum-style prefixes. */
export function normalizeStatus(status: string | number | undefined): 'pending' | 'claimed' | 'expired' | 'unknown' {
  const s = String(status === undefined ? '' : status).toUpperCase();
  if (/PENDING$/.test(s)) return 'pending';
  if (/CLAIMED$/.test(s)) return 'claimed';
  if (/EXPIRED$/.test(s)) return 'expired';
  return 'unknown';
}

export function parsePairing(raw: RawPairing, nowMs: number): TvPairing {
  if (!raw.code || !raw.pairingSecret) throw new Error('Malformed pairing response');
  const poll = toNumber(raw.pollIntervalMs, DEFAULT_POLL_MS);
  return {
    code: raw.code,
    pairingSecret: raw.pairingSecret,
    expiresAtMs: parseExpiry(raw.expiresAt, nowMs),
    pollIntervalMs: Math.min(Math.max(poll || DEFAULT_POLL_MS, 1000), 30000),
  };
}

export function parsePoll(raw: RawPoll): TvPollResult {
  const status = normalizeStatus(raw.status);
  if (status === 'claimed') {
    const tokens = tokensFromLogin(raw.login);
    if (tokens && raw.roomId) return { status: 'claimed', tokens, roomId: raw.roomId };
    return { status: 'expired' }; // malformed claim: start over
  }
  // Unknown secret → EXPIRED on the server; anything unrecognized also restarts.
  if (status === 'expired' || status === 'unknown') return { status: 'expired' };
  return { status: 'pending' };
}

export function parseDevices(raw: { tvs?: RawDevice[] } | undefined): TvDevice[] {
  return ((raw && raw.tvs) || [])
    .filter((d) => !!d.userId)
    .map((d) => ({
      userId: d.userId as string,
      name: d.name || 'TV',
      pairedAt: toNumber(d.pairedAt),
      pairedBy: d.pairedBy || '',
    }));
}

/** Distinct messages for the claim failures the server reports. */
export function claimErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 404:
        return 'That code is wrong or has expired. Check the code on the TV.';
      case 403:
        return 'You don’t have playback control in this room, so you can’t pair a TV to it.';
      case 401:
        return 'Too many wrong codes. Wait a few minutes, then try again.';
      case 429:
        return 'Too many attempts. Wait a minute, then try again.';
      default:
        return error.message;
    }
  }
  return 'Network error. Check your connection and try again.';
}

/** How long the TV waits before starting a new pairing after a failure. */
export function startRetryDelayMs(error: unknown): number {
  // Start is Auth rate-limited (5/min/IP): after a 429 wait out the window.
  return error instanceof ApiError && error.status === 429 ? 65_000 : 5_000;
}

/** Poll delay after a failed poll. */
export function pollRetryDelayMs(error: unknown, intervalMs: number): number {
  if (error instanceof ApiError && error.status === 429) return 30_000;
  return Math.max(intervalMs, 3000);
}

export async function createPairing(api: ApiClient): Promise<TvPairing> {
  const raw = await api.request<RawPairing>('POST', '/api/tv/pairings', {}, { auth: false });
  return parsePairing(raw, Date.now());
}

export async function pollPairing(api: ApiClient, pairingSecret: string): Promise<TvPollResult> {
  const raw = await api.request<RawPoll>('POST', '/api/tv/pairings/poll', { pairingSecret }, { auth: false });
  return parsePoll(raw);
}

/** 401 here is the brute-force lockout, not an expired session: never retry it. */
export function claimPairing(api: ApiClient, code: string, roomId: string): Promise<unknown> {
  return api.request('POST', '/api/tv/pairings/claim', { code, roomId }, { retryOn401: false });
}

export async function listTvDevices(api: ApiClient, roomId: string): Promise<TvDevice[]> {
  return parseDevices(await api.request<{ tvs?: RawDevice[] }>('GET', `/api/rooms/${encodeURIComponent(roomId)}/tvs`));
}

export function revokeTvDevice(api: ApiClient, roomId: string, userId: string): Promise<unknown> {
  return api.request(
    'POST',
    `/api/rooms/${encodeURIComponent(roomId)}/tvs/${encodeURIComponent(userId)}/revoke`,
  );
}

/** Codes are 6 chars from A-Z/2-9, case-insensitive; normalize what users type. */
export function normalizeCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}
