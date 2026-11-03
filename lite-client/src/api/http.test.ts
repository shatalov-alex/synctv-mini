import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, type FetchLike } from './http';
import { TokenStore } from './session';
import { fakeJwt } from './testing';

const NOW = 1_800_000_000_000;
const fresh = () => fakeJwt(NOW / 1000 + 3600);
const nearlyExpired = () => fakeJwt(NOW / 1000 + 30);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface Call {
  url: string;
  method: string;
  auth: string | undefined;
  body: unknown;
}

function harness(handler: (call: Call) => Response | Promise<Response>, tokens = { accessToken: fresh(), refreshToken: 'R1' }) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init = {}) => {
    const headers = (init.headers || {}) as Record<string, string>;
    const call: Call = {
      url,
      method: init.method || 'GET',
      auth: headers.Authorization,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return handler(call);
  };
  const store = new TokenStore('t');
  store.set(tokens);
  const onSignedOut = vi.fn();
  const api = new ApiClient({ store, fetch: fetchImpl, now: () => NOW, onSignedOut });
  return { api, calls, store, onSignedOut };
}

describe('ApiClient', () => {
  it('sends the bearer token and decodes JSON', async () => {
    const { api, calls } = harness(() => json(200, { id: 'u1' }));
    await expect(api.request('GET', '/api/user')).resolves.toEqual({ id: 'u1' });
    expect(calls[0].auth).toMatch(/^Bearer /);
  });

  it('omits auth for public endpoints and builds query strings', async () => {
    const { api, calls } = harness(() => json(200, {}));
    await api.request('GET', '/api/public/time', undefined, { auth: false, query: { a: 1, b: undefined, c: 'x y' } });
    expect(calls[0].auth).toBeUndefined();
    expect(calls[0].url).toBe('/api/public/time?a=1&c=x%20y');
  });

  it('on 401 refreshes once and retries with the new token', async () => {
    const newAccess = fakeJwt(NOW / 1000 + 3600) + 'new';
    const { api, calls, store } = harness((call) => {
      if (call.url === '/api/auth/refresh') return json(200, { accessToken: newAccess, refreshToken: 'R2' });
      return call.auth === `Bearer ${newAccess}` ? json(200, { ok: true }) : json(401, { code: 16, message: 'expired' });
    });
    await expect(api.request('GET', '/api/user')).resolves.toEqual({ ok: true });
    expect(calls.map((c) => c.url)).toEqual(['/api/user', '/api/auth/refresh', '/api/user']);
    expect(calls[1].body).toEqual({ refreshToken: 'R1' });
    expect(calls[1].auth).toBeUndefined();
    expect(store.get()).toEqual({ accessToken: newAccess, refreshToken: 'R2' });
  });

  it('refreshes proactively when the access token is about to expire', async () => {
    const { api, calls } = harness(
      (call) => (call.url === '/api/auth/refresh' ? json(200, { accessToken: fresh() }) : json(200, {})),
      { accessToken: nearlyExpired(), refreshToken: 'R1' },
    );
    await api.request('GET', '/api/user');
    expect(calls.map((c) => c.url)).toEqual(['/api/auth/refresh', '/api/user']);
  });

  it('keeps the old refresh token when the response omits it', async () => {
    const { api, store } = harness(
      (call) => (call.url === '/api/auth/refresh' ? json(200, { accessToken: fresh() }) : json(200, {})),
      { accessToken: nearlyExpired(), refreshToken: 'R1' },
    );
    await api.request('GET', '/api/user');
    expect(store.get()!.refreshToken).toBe('R1');
  });

  it('single-flights concurrent refreshes', async () => {
    let refreshes = 0;
    const { api } = harness(
      async (call) => {
        if (call.url === '/api/auth/refresh') {
          refreshes++;
          await new Promise((r) => setTimeout(r, 5));
          return json(200, { accessToken: fresh(), refreshToken: 'R2' });
        }
        return json(200, {});
      },
      { accessToken: nearlyExpired(), refreshToken: 'R1' },
    );
    await Promise.all([api.request('GET', '/a'), api.request('GET', '/b'), api.request('GET', '/c')]);
    expect(refreshes).toBe(1);
  });

  it('uses reauthenticate when the refresh token is rejected', async () => {
    const reauthed = fresh() + 'tg';
    const { api, store, onSignedOut } = harness((call) => {
      if (call.url === '/api/auth/refresh') return json(401, { code: 16, message: 'bad refresh' });
      return call.auth === `Bearer ${reauthed}` ? json(200, { ok: 1 }) : json(401, {});
    });
    api.setReauthenticate(async () => ({ accessToken: reauthed, refreshToken: 'R9' }));
    await expect(api.request('GET', '/x')).resolves.toEqual({ ok: 1 });
    expect(store.get()!.refreshToken).toBe('R9');
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it('signs out when refresh is rejected and reauth is unavailable', async () => {
    const { api, store, onSignedOut } = harness((call) =>
      call.url === '/api/auth/refresh' ? json(401, {}) : json(401, { code: 16, message: 'Unauthenticated' }),
    );
    const error = (await api.request('GET', '/x').catch((e) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);
    expect(store.get()).toBeNull();
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it('keeps the session on transient refresh failures', async () => {
    const { api, store, onSignedOut } = harness((call) =>
      call.url === '/api/auth/refresh' ? json(503, {}) : json(401, {}),
    );
    await expect(api.request('GET', '/x')).rejects.toBeInstanceOf(ApiError);
    expect(store.get()).not.toBeNull();
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it('decodes google.rpc.Status errors', async () => {
    const { api } = harness(() => json(403, { code: 7, message: 'Only the room creator can manage invites' }));
    const error = (await api.request('GET', '/x').catch((e) => e)) as ApiError;
    expect(error.message).toBe('Only the room creator can manage invites');
    expect(error.code).toBe(7);
    expect(error.status).toBe(403);
  });
});
