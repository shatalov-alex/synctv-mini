import { describe, expect, it } from 'vitest';
import { fakeJwt } from './testing';
import { jwtExpiry, secondsLeft, shouldRefresh, TokenStore, type KeyValueStorage } from './session';


function memory(): KeyValueStorage & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => void (data[k] = v),
    removeItem: (k) => void delete data[k],
  };
}

describe('jwt expiry', () => {
  it('reads exp from a base64url payload', () => {
    expect(jwtExpiry(fakeJwt(1700000000))).toBe(1700000000);
  });
  it('returns null for missing exp or garbage', () => {
    expect(jwtExpiry(fakeJwt(undefined))).toBeNull();
    expect(jwtExpiry('not-a-jwt')).toBeNull();
    expect(jwtExpiry('a.@@@.c')).toBeNull();
  });
  it('refreshes inside the 120 s margin only', () => {
    const now = 1_000_000_000_000;
    const exp = now / 1000 + 3600;
    expect(secondsLeft(fakeJwt(exp), now)).toBe(3600);
    expect(shouldRefresh(fakeJwt(exp), now)).toBe(false);
    expect(shouldRefresh(fakeJwt(now / 1000 + 119), now)).toBe(true);
    expect(shouldRefresh(fakeJwt(undefined), now)).toBe(false);
  });
});

describe('TokenStore', () => {
  it('persists, reloads and clears tokens', () => {
    const storage = memory();
    const a = new TokenStore('k', storage);
    expect(a.get()).toBeNull();
    a.set({ accessToken: 'A', refreshToken: 'R' });
    expect(new TokenStore('k', storage).get()).toEqual({ accessToken: 'A', refreshToken: 'R' });
    a.clear();
    expect(storage.data.k).toBeUndefined();
    expect(new TokenStore('k', storage).get()).toBeNull();
  });
  it('ignores corrupt storage', () => {
    const storage = memory();
    storage.setItem('k', '{nope');
    expect(new TokenStore('k', storage).get()).toBeNull();
  });
  it('notifies subscribers', () => {
    const store = new TokenStore('k');
    const seen: Array<string | null> = [];
    const off = store.subscribe((t) => seen.push(t ? t.accessToken : null));
    store.set({ accessToken: 'x', refreshToken: '' });
    store.clear();
    off();
    store.set({ accessToken: 'y', refreshToken: '' });
    expect(seen).toEqual(['x', null]);
  });
});
