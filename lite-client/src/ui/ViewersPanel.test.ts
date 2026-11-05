import { describe, expect, it } from 'vitest';
import { sortViewers, viewerName } from './ViewersPanel';

describe('viewerName', () => {
  it('uses the Telegram name', () => {
    expect(viewerName({ firstName: 'Olena', lastName: 'K', username: 'tg_1' })).toBe('Olena K');
    expect(viewerName({ firstName: 'Olena', username: 'tg_1' })).toBe('Olena');
  });
  it('leaves the name to the @username when that is all there is', () => {
    expect(viewerName({ telegramUsername: 'olena', username: 'tg_1' })).toBe('');
  });
  it('falls back to the account name', () => {
    expect(viewerName({ username: 'admin' })).toBe('admin');
  });
  it('labels a TV with who added it', () => {
    expect(viewerName({ isTv: true, username: 'tv_1', pairedByName: 'Alex S' })).toBe('TV, added by Alex S');
    expect(viewerName({ isTv: true, username: 'tv_1' })).toBe('TV');
  });
});

describe('sortViewers', () => {
  it('puts online people first and keeps the order otherwise', () => {
    const list = [{ userId: 'a' }, { userId: 'b', isOnline: true }, { userId: 'c' }, { userId: 'd', isOnline: true }];
    expect(sortViewers(list).map((v) => v.userId)).toEqual(['b', 'd', 'a', 'c']);
  });
});
