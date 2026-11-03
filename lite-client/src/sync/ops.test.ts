import { describe, expect, it } from 'vitest';
import { OpTracker, uuidv4 } from './ops';

describe('OpTracker', () => {
  it('ignores unknown op ids (other clients / server-originated)', () => {
    const t = new OpTracker<string>();
    expect(t.acknowledge('', 'S')).toEqual({ handled: false });
    expect(t.acknowledge('nope', 'S')).toEqual({ handled: false });
  });

  it('acks the latest active op with the authoritative state (store, no player sync)', () => {
    const t = new OpTracker<string>();
    t.remember('a', 'prev');
    expect(t.acknowledge('a', 'auth')).toEqual({ handled: true, state: 'auth' });
    expect(t.acknowledge('a', 'auth')).toEqual({ handled: true }); // duplicate → drop
  });

  it('drops the ack of a superseded op and rebases the newer op’s rollback state', () => {
    const t = new OpTracker<string>();
    t.remember('a', 'S0');
    t.remember('b', 'Sa');
    expect(t.acknowledge('a', 'A-auth')).toEqual({ handled: true });
    // b rejected → roll back to the authoritative state of a, not the optimistic one
    expect(t.reject('b')).toEqual({ handled: true, state: 'A-auth' });
  });

  it('rolls back the active op to its previous state', () => {
    const t = new OpTracker<string>();
    t.remember('a', 'S0');
    expect(t.reject('a')).toEqual({ handled: true, state: 'S0' });
    expect(t.activeOperationId).toBeNull();
  });

  it('rejecting a superseded op hands its previous state to the dependent op', () => {
    const t = new OpTracker<string>();
    t.remember('a', 'S0');
    t.remember('b', 'Sa');
    expect(t.reject('a')).toEqual({ handled: true });
    expect(t.reject('b')).toEqual({ handled: true, state: 'S0' });
  });

  it('rejecting an already acknowledged op is a no-op', () => {
    const t = new OpTracker<string>();
    t.remember('a', 'S0');
    t.acknowledge('a', 'A');
    expect(t.reject('a')).toEqual({ handled: false });
  });

  it('forgets ops after the retention window', () => {
    let now = 0;
    const t = new OpTracker<string>(60_000, () => now);
    t.remember('a', 'S0');
    now = 60_001;
    expect(t.acknowledge('a', 'A')).toEqual({ handled: false });
    expect(t.activeOperationId).toBeNull();
  });
});

describe('uuidv4', () => {
  it('produces RFC 4122 v4 ids', () => {
    const id = uuidv4();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidv4()).not.toBe(id);
  });
});
