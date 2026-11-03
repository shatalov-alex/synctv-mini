import { describe, expect, it } from 'vitest';
import { inviteLink, pairLink, parseStartParam, telegramShareLink } from './links';
import { matchRoute } from './router';
import { formatExpiry, formatTime } from './format';
import { tvAction } from './pages/tvKeys';

const cfg = { botUsername: 'synctv_bot', appShortName: 'watch' };

describe('links', () => {
  it('builds Mini App invite links', () => {
    expect(inviteLink('tok_ABC-123', cfg)).toBe('https://t.me/synctv_bot/watch?startapp=tok_ABC-123');
    expect(inviteLink('x', { botUsername: '', appShortName: 'watch' })).toBeNull();
    expect(inviteLink('tok', { botUsername: 'synctv_bot', appShortName: '' })).toBe(
      'https://t.me/synctv_bot?startapp=tok',
    );
  });
  it('builds share links', () => {
    expect(telegramShareLink('https://t.me/a/b?startapp=x', 'Hi')).toBe(
      'https://t.me/share/url?url=https%3A%2F%2Ft.me%2Fa%2Fb%3Fstartapp%3Dx&text=Hi',
    );
  });
  it('pairs via the Mini App when configured, else via /pair', () => {
    expect(pairLink('123456', 'https://tv.example', cfg)).toBe('https://t.me/synctv_bot/watch?startapp=pair-123456');
    expect(pairLink('123456', 'https://tv.example', { botUsername: '', appShortName: '' })).toBe(
      'https://tv.example/pair?code=123456',
    );
  });
  it('classifies start params', () => {
    expect(parseStartParam(undefined)).toEqual({ kind: 'none' });
    expect(parseStartParam('pair-654321')).toEqual({ kind: 'pair', code: '654321' });
    expect(parseStartParam('pair-')).toEqual({ kind: 'none' });
    expect(parseStartParam('Ab_c-9')).toEqual({ kind: 'invite', token: 'Ab_c-9' });
  });
});

describe('router', () => {
  it('matches the SPA routes', () => {
    expect(matchRoute('/', '')).toEqual({ name: 'home' });
    expect(matchRoute('/tv/', '')).toEqual({ name: 'tv' });
    expect(matchRoute('/room/room_abc', '')).toEqual({ name: 'room', roomId: 'room_abc' });
    expect(matchRoute('/pair', '?x=1&code=12%2034')).toEqual({ name: 'pair', code: '12 34' });
    expect(matchRoute('/pair', '')).toEqual({ name: 'pair', code: '' });
    expect(matchRoute('/room/a/b', '')).toEqual({ name: 'notFound' });
  });
});

describe('format', () => {
  it('formats media time', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(65.9)).toBe('1:05');
    expect(formatTime(3725)).toBe('1:02:05');
    expect(formatTime(NaN)).toBe('0:00');
  });
  it('formats invite expiry', () => {
    const now = 1_000_000_000_000;
    expect(formatExpiry(0, now)).toBe('never expires');
    expect(formatExpiry(now / 1000 - 1, now)).toBe('expired');
    expect(formatExpiry(now / 1000 + 600, now)).toBe('expires in 10 min');
    expect(formatExpiry(now / 1000 + 86400, now)).toBe('expires in 24 h');
  });
});

describe('tv remote keys', () => {
  it('maps modern keys and legacy keyCodes', () => {
    expect(tvAction(' ', 32)).toBe('toggle');
    expect(tvAction('Enter', 13)).toBe('toggle');
    expect(tvAction('ArrowLeft', 37)).toBe('back10');
    expect(tvAction('Unidentified', 39)).toBe('forward10');
    expect(tvAction(undefined, 10252)).toBe('toggle');
    expect(tvAction(undefined, 415)).toBe('play');
    expect(tvAction('a', 65)).toBeNull();
  });
});
