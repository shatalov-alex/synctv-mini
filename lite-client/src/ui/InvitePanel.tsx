import { useEffect, useState } from 'preact/hooks';
import type { ApiClient } from '../api/http';
import { createInvite, listInvites, revokeInvites } from '../api/endpoints';
import { toNumber, type RoomInvite } from '../api/types';
import { copyText, errorMessage, formatExpiry } from '../format';
import { inviteLink, telegramShareLink } from '../links';
import { openTelegramLink } from '../telegram';

const TTL_OPTIONS: Array<[string, number]> = [
  ['1 hour', 3600],
  ['24 hours', 86400],
  ['7 days', 7 * 86400],
  ['30 days', 30 * 86400],
];

function isLive(invite: RoomInvite, nowMs: number): boolean {
  const exp = toNumber(invite.expiresAt);
  const max = invite.maxUses || 0;
  return !invite.revoked && (!exp || exp > nowMs / 1000) && (!max || (invite.uses || 0) < max);
}

export function InvitePanel({ api, roomId }: { api: ApiClient; roomId: string }) {
  const [invites, setInvites] = useState<RoomInvite[]>([]);
  const [ttl, setTtl] = useState(86400);
  const [maxUses, setMaxUses] = useState(1);
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = () => listInvites(api, roomId).then(setInvites, (e) => setError(errorMessage(e)));
  useEffect(() => {
    void reload();
  }, [roomId]);

  const create = async () => {
    setBusy(true);
    setError('');
    setCopied(false);
    try {
      const res = await createInvite(api, roomId, { ttlSeconds: ttl, maxUses });
      const url = res.token ? inviteLink(res.token) : null;
      if (!url) {
        setError('Set VITE_TG_BOT_USERNAME and VITE_TG_APP_SHORT_NAME at build time to make invite links.');
      }
      setLink(url || '');
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: number | string) => {
    if (id === 0 && !confirm('Revoke all active invite links?')) return;
    try {
      await revokeInvites(api, roomId, id);
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const now = Date.now();
  const live = invites.filter((i) => isLive(i, now));

  return (
    <section class="card">
      <h2>Invite</h2>
      <div class="row">
        <select value={String(ttl)} onChange={(e) => setTtl(Number((e.target as HTMLSelectElement).value))}>
          {TTL_OPTIONS.map(([label, seconds]) => (
            <option key={seconds} value={String(seconds)}>
              {label}
            </option>
          ))}
        </select>
        <select value={String(maxUses)} onChange={(e) => setMaxUses(Number((e.target as HTMLSelectElement).value))}>
          {[1, 2, 5, 10].map((n) => (
            <option key={n} value={String(n)}>
              {n === 1 ? '1 person' : `${n} people`}
            </option>
          ))}
        </select>
        <button class="primary" disabled={busy} onClick={create}>
          Create link
        </button>
      </div>
      {link && (
        <div class="stack">
          <input type="text" readOnly value={link} onFocus={(e) => (e.target as HTMLInputElement).select()} />
          <div class="row">
            <button onClick={() => copyText(link).then(setCopied)}>{copied ? 'Copied ✓' : 'Copy link'}</button>
            <button onClick={() => openTelegramLink(telegramShareLink(link, 'Watch with me 🍿'))}>Share in Telegram</button>
          </div>
          <p class="muted small">The link is shown only once.</p>
        </div>
      )}
      {live.length > 0 && (
        <ul class="list">
          {live.map((i) => (
            <li key={String(i.id)}>
              <span class="grow small">
                #{String(i.id)} · used {i.uses || 0}/{i.maxUses || '∞'} · {formatExpiry(toNumber(i.expiresAt), now)}
              </span>
              <button class="ghost" onClick={() => revoke(i.id || 0)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {live.length > 1 && (
        <button class="ghost danger" onClick={() => revoke(0)}>
          Revoke all
        </button>
      )}
      {error && <p class="error">{error}</p>}
    </section>
  );
}
