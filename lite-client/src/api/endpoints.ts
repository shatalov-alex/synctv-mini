// Typed wrappers for the SynCTV HTTP endpoints the lite client uses.
import type { ApiClient } from './http';
import type { Tokens } from './session';
import type {
  CreateInviteResponse,
  GetPlaybackResponse,
  GetRoomResponse,
  ListPlaylistItemsResponse,
  LoginResponse,
  Media,
  MyRoom,
  PlaybackState,
  RedeemInviteResponse,
  Room,
  RoomInvite,
  User,
} from './types';

const enc = encodeURIComponent;

export function tokensFromLogin(login: LoginResponse | undefined): Tokens | null {
  if (!login || !login.accessToken) return null;
  return { accessToken: login.accessToken, refreshToken: login.refreshToken || '' };
}

// ---- auth (public) ----

export function loginWithTelegram(api: ApiClient, initData: string): Promise<LoginResponse> {
  return api.request('POST', '/api/auth/telegram', { initData }, { auth: false });
}

/** Omitting `token` makes the server use the Mini App start_param from initData. */
export function redeemInvite(api: ApiClient, initData: string, token?: string): Promise<RedeemInviteResponse> {
  const body: { initData: string; token?: string } = { initData };
  if (token) body.token = token;
  return api.request('POST', '/api/invites/redeem', body, { auth: false });
}

export function getMe(api: ApiClient): Promise<User> {
  return api.request('GET', '/api/user');
}

// ---- rooms ----

export async function listMyRooms(api: ApiClient): Promise<MyRoom[]> {
  const res = await api.request<{ rooms?: MyRoom[] }>('GET', '/api/user/rooms', undefined, {
    query: { pageSize: 100 },
  });
  return res.rooms || [];
}

export function createRoom(api: ApiClient, name: string): Promise<Room> {
  return api.request('POST', '/api/rooms', { name });
}

export function getRoom(api: ApiClient, roomId: string): Promise<GetRoomResponse> {
  return api.request('GET', `/api/rooms/${enc(roomId)}`);
}

// ---- playlist / media ----

export async function listRootMedia(api: ApiClient, roomId: string): Promise<Media[]> {
  const res = await api.request<ListPlaylistItemsResponse>('POST', `/api/rooms/${enc(roomId)}/media/list`, {
    pageSize: 100,
  });
  return res.media || [];
}

/** PlaybackProxyMode.PLAYBACK_PROXY_MODE_ONLY (source_config.proto). */
export const PROXY_MODE_ONLY = 2;

export function addDirectUrlMedia(api: ApiClient, roomId: string, url: string, name?: string): Promise<Media> {
  const body: Record<string, unknown> = {
    // Proxy through the server (PLAYBACK_PROXY_MODE_ONLY): many hosts hand out
    // links bound to the IP that requested them or block some networks, so a
    // viewer on another network (e.g. mobile data) gets refused when fetching
    // directly. The server fetches for everyone, as the official client does.
    sourceConfig: { directUrl: { medias: [{ url }], proxyMode: PROXY_MODE_ONLY } },
  };
  if (name) body.name = name;
  return api.request('POST', `/api/rooms/${enc(roomId)}/media`, body);
}

export function deleteMedia(api: ApiClient, roomId: string, mediaId: string): Promise<unknown> {
  return api.request('DELETE', `/api/rooms/${enc(roomId)}/media/${enc(mediaId)}`);
}

// ---- playback (HTTP) ----

export function getPlayback(api: ApiClient, roomId: string): Promise<GetPlaybackResponse> {
  return api.request('GET', `/api/rooms/${enc(roomId)}/playback`);
}

export function startPlayback(api: ApiClient, roomId: string, mediaId: string): Promise<PlaybackState> {
  return api.request('POST', `/api/rooms/${enc(roomId)}/playback/start`, { mediaId });
}

export function playNext(api: ApiClient, roomId: string): Promise<PlaybackState> {
  return api.request('POST', `/api/rooms/${enc(roomId)}/playback/next`, {});
}

export function playPrevious(api: ApiClient, roomId: string): Promise<PlaybackState> {
  return api.request('POST', `/api/rooms/${enc(roomId)}/playback/previous`, {});
}

export type PlaybackUpdate =
  | { type: 'play'; position?: number }
  | { type: 'pause'; position?: number }
  | { type: 'seek'; position: number }
  | { type: 'speed'; speed: number };

const UPDATE_TYPE = {
  play: 'PLAYBACK_UPDATE_TYPE_PLAY',
  pause: 'PLAYBACK_UPDATE_TYPE_PAUSE',
  seek: 'PLAYBACK_UPDATE_TYPE_SEEK',
  speed: 'PLAYBACK_UPDATE_TYPE_SPEED',
} as const;

export function updatePlayback(api: ApiClient, roomId: string, update: PlaybackUpdate): Promise<PlaybackState> {
  const body: Record<string, unknown> = { type: UPDATE_TYPE[update.type] };
  if (update.type === 'play' || update.type === 'pause') body.playing = update.type === 'play';
  if ('position' in update && update.position !== undefined) body.position = update.position;
  if (update.type === 'speed') body.speed = update.speed;
  return api.request('PATCH', `/api/rooms/${enc(roomId)}/playback`, body);
}

// ---- invites (room creator) ----

export function createInvite(
  api: ApiClient,
  roomId: string,
  opts: { ttlSeconds?: number; maxUses?: number } = {},
): Promise<CreateInviteResponse> {
  const body: Record<string, number> = {};
  if (opts.ttlSeconds) body.ttlSeconds = opts.ttlSeconds;
  if (opts.maxUses) body.maxUses = opts.maxUses;
  return api.request('POST', `/api/rooms/${enc(roomId)}/invites`, body);
}

export async function listInvites(api: ApiClient, roomId: string): Promise<RoomInvite[]> {
  const res = await api.request<{ invites?: RoomInvite[] }>('GET', `/api/rooms/${enc(roomId)}/invites`);
  return res.invites || [];
}

/** inviteId 0 revokes every live invite of the room. */
export function revokeInvites(api: ApiClient, roomId: string, inviteId: number | string): Promise<{ revoked?: string }> {
  return api.request('POST', `/api/rooms/${enc(roomId)}/invites/revoke`, { inviteId: String(inviteId) });
}
