// TV pairing API. The server side is being built in parallel; everything that
// depends on its exact wire format (paths, enum spelling, field names) lives here.
import type { ApiClient } from './http';
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

const DEFAULT_POLL_MS = 2000;

/** Accepts seconds or milliseconds since epoch, or an RFC 3339 string. */
export function parseExpiry(value: Int64 | undefined, nowMs: number): number {
  if (typeof value === 'string' && /[-T:]/.test(value)) {
    const parsed = Date.parse(value);
    if (!isNaN(parsed)) return parsed;
  }
  const n = toNumber(value, 0);
  if (n <= 0) return nowMs + 5 * 60 * 1000;
  return n < 1e12 ? n * 1000 : n;
}

/** Maps PENDING / TV_PAIRING_STATUS_PENDING / 1 (etc.) to a normalized status. */
export function normalizeStatus(status: string | number | undefined): 'pending' | 'claimed' | 'expired' | 'unknown' {
  if (typeof status === 'number') {
    return status === 1 ? 'pending' : status === 2 ? 'claimed' : status === 3 ? 'expired' : 'unknown';
  }
  const s = String(status || '').toUpperCase();
  if (/PENDING$/.test(s)) return 'pending';
  if (/CLAIMED$/.test(s)) return 'claimed';
  if (/(EXPIRED|CONSUMED|REVOKED)$/.test(s)) return 'expired';
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
    // Claimed but tokens already handed out (or malformed): start over.
    return { status: 'expired' };
  }
  if (status === 'expired') return { status: 'expired' };
  return { status: 'pending' };
}

export async function createPairing(api: ApiClient): Promise<TvPairing> {
  const raw = await api.request<RawPairing>('POST', '/api/tv/pairings', {}, { auth: false });
  return parsePairing(raw, Date.now());
}

export async function pollPairing(api: ApiClient, pairingSecret: string): Promise<TvPollResult> {
  const raw = await api.request<RawPoll>('POST', '/api/tv/pairings/poll', { pairingSecret }, { auth: false });
  return parsePoll(raw);
}

export function claimPairing(api: ApiClient, code: string, roomId: string): Promise<unknown> {
  return api.request('POST', '/api/tv/pairings/claim', { code, roomId });
}

/** Pairing codes are shown as digits/letters; normalize what users type. */
export function normalizeCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}
