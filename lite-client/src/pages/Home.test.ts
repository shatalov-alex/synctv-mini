import { describe, expect, it } from 'vitest';
import { isAdmin } from './Home';
import type { User } from '../api/types';

const user = (role: unknown) => ({ role }) as unknown as User;

describe('isAdmin', () => {
  it('accepts root and admin as served (integers) and as enum names', () => {
    expect(isAdmin(user(1))).toBe(true);
    expect(isAdmin(user(2))).toBe(true);
    expect(isAdmin(user('USER_ROLE_ROOT'))).toBe(true);
    expect(isAdmin(user('USER_ROLE_ADMIN'))).toBe(true);
  });

  it('rejects regular users and missing data', () => {
    expect(isAdmin(user(3))).toBe(false);
    expect(isAdmin(user('USER_ROLE_USER'))).toBe(false);
    expect(isAdmin(user(undefined))).toBe(false);
    expect(isAdmin(null)).toBe(false);
  });
});
