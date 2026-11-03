import { describe, expect, it } from 'vitest';
import { normalizeCode, normalizeStatus, parseExpiry, parsePairing, parsePoll } from './tv';

describe('tv pairing parsing', () => {
  it('normalizes enum spellings', () => {
    expect(normalizeStatus('PENDING')).toBe('pending');
    expect(normalizeStatus('TV_PAIRING_STATUS_CLAIMED')).toBe('claimed');
    expect(normalizeStatus('expired')).toBe('expired');
    expect(normalizeStatus(1)).toBe('pending');
    expect(normalizeStatus(2)).toBe('claimed');
    expect(normalizeStatus(3)).toBe('expired');
    expect(normalizeStatus(undefined)).toBe('unknown');
  });

  it('accepts seconds, milliseconds and RFC 3339 expiries', () => {
    const now = 1_800_000_000_000;
    expect(parseExpiry('1800000300', now)).toBe(1_800_000_300_000);
    expect(parseExpiry(1_800_000_300_000, now)).toBe(1_800_000_300_000);
    expect(parseExpiry('2027-01-15T08:00:00Z', now)).toBe(Date.parse('2027-01-15T08:00:00Z'));
    expect(parseExpiry(undefined, now)).toBe(now + 300_000);
  });

  it('clamps the poll interval', () => {
    const p = parsePairing({ code: '123456', pairingSecret: 's', pollIntervalMs: '50' }, 0);
    expect(p.pollIntervalMs).toBe(1000);
    expect(parsePairing({ code: '1', pairingSecret: 's' }, 0).pollIntervalMs).toBe(2000);
    expect(() => parsePairing({ code: '1' }, 0)).toThrow();
  });

  it('delivers tokens only for a complete claim', () => {
    expect(parsePoll({ status: 'PENDING' })).toEqual({ status: 'pending' });
    expect(parsePoll({ status: 'CLAIMED', roomId: 'room_1', login: { accessToken: 'a', refreshToken: 'r' } })).toEqual({
      status: 'claimed',
      roomId: 'room_1',
      tokens: { accessToken: 'a', refreshToken: 'r' },
    });
    // Tokens already handed out once → treat as expired and re-pair.
    expect(parsePoll({ status: 'CLAIMED', roomId: 'room_1' })).toEqual({ status: 'expired' });
    expect(parsePoll({ status: 'EXPIRED' })).toEqual({ status: 'expired' });
  });

  it('normalizes typed codes', () => {
    expect(normalizeCode(' 12-34 56 ')).toBe('123456');
    expect(normalizeCode('ab12')).toBe('AB12');
  });
});
