import { useEffect, useRef, useState } from 'preact/hooks';
import type { ApiClient } from '../api/http';
import { listRoomViewers, removeMember } from '../api/endpoints';
import type { RoomViewer } from '../api/types';
import { errorMessage } from '../format';
import { confirmAction } from '../telegram';

const PRESENCE_SETTLE_MS = [1500, 4000, 8000];
/** In case an event got lost, e.g. a phone that dropped off without saying so. */
const REFRESH_MS = 30_000;

/** How the list names someone: their Telegram name, else their account's. */
export function viewerName(viewer: RoomViewer): string {
  if (viewer.isTv) return viewer.pairedByName ? `TV, added by ${viewer.pairedByName}` : 'TV';
  const name = [viewer.firstName, viewer.lastName].filter(Boolean).join(' ');
  return name || (viewer.telegramUsername ? '' : viewer.username || 'Unknown');
}

/** Online first, keeping the server's order within each group. */
export function sortViewers(viewers: RoomViewer[]): RoomViewer[] {
  return [...viewers.filter((v) => v.isOnline), ...viewers.filter((v) => !v.isOnline)];
}

export function ViewersPanel(props: {
  api: ApiClient;
  roomId: string;
  /** Changes whenever someone comes, goes, or may have while we were disconnected. */
  refreshKey: string;
  canRemove: boolean;
}) {
  const { api, roomId, refreshKey, canRemove } = props;
  const [viewers, setViewers] = useState<RoomViewer[] | null>(null);
  const [error, setError] = useState('');
  const request = useRef(0);

  const reload = () => {
    const current = ++request.current;
    return listRoomViewers(api, roomId).then(
      (list) => {
        if (current !== request.current) return;
        setViewers(sortViewers(list));
        setError('');
      },
      (e) => {
        if (current === request.current) setError(errorMessage(e));
      },
    );
  };

  useEffect(() => {
    void reload();
    // The event arrives a few seconds before the server's presence catches up with it.
    const settling = PRESENCE_SETTLE_MS.map((ms) => setTimeout(reload, ms));
    return () => settling.forEach(clearTimeout);
  }, [roomId, refreshKey]);
  useEffect(() => {
    const timer = setInterval(reload, REFRESH_MS);
    return () => clearInterval(timer);
  }, [roomId]);

  const remove = async (viewer: RoomViewer) => {
    if (!viewer.userId) return;
    const name = viewerName(viewer) || `@${viewer.telegramUsername}`;
    if (!(await confirmAction(`Remove ${name} from the room? They can only come back through an invite link.`))) return;
    removeMember(api, roomId, viewer.userId).then(reload, (e) => setError(errorMessage(e)));
  };

  const online = viewers ? viewers.filter((v) => v.isOnline).length : 0;
  return (
    <section class="card">
      <h2>In this room{viewers ? ` (${online} online)` : ''}</h2>
      {viewers && viewers.length > 0 && (
        <ul class="list viewers">
          {viewers.map((v) => (
            <li key={v.userId}>
              <span class={v.isOnline ? 'presence online' : 'presence'} aria-label={v.isOnline ? 'Online' : 'Offline'} />
              <span class="grow viewer-name">
                {viewerName(v)}
                {v.telegramUsername && !v.isTv && <span class="muted"> @{v.telegramUsername}</span>}
                {v.isCreator && <span class="muted small"> · room creator</span>}
              </span>
              {canRemove && !v.isCreator && !v.isTv && (
                <button class="ghost" onClick={() => remove(v)} aria-label="Remove from room">
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p class="error">{error}</p>}
    </section>
  );
}
