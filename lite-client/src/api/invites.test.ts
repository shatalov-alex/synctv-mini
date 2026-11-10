import { describe, expect, it } from 'vitest';
import type { ApiClient } from './http';
import { createInvite } from './endpoints';

function capture() {
  const bodies: unknown[] = [];
  const api = { request: async (_m: string, _p: string, body: unknown) => (bodies.push(body), {}) };
  return { api: api as unknown as ApiClient, bodies };
}

describe('createInvite', () => {
  it('sends limits as given and 0 as never / anyone', async () => {
    const { api, bodies } = capture();
    await createInvite(api, 'room_1', { ttlSeconds: 3600, maxUses: 2 });
    await createInvite(api, 'room_1', { ttlSeconds: 0, maxUses: 0 });
    await createInvite(api, 'room_1');
    expect(bodies).toEqual([
      { ttlSeconds: 3600, maxUses: 2 },
      { noExpiry: true, unlimitedUses: true },
      {},
    ]);
  });
});
