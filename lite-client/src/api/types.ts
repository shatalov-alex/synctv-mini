// JSON shapes served by the SynCTV HTTP API (pbjson mapping of client.proto):
// camelCase keys, int64/uint64 as strings, enums as their proto names, and
// default values (0, "", false, empty lists) omitted. Every field is therefore
// optional here; normalize with the helpers below. Request bodies are parsed
// strictly by the server: unknown fields are rejected, so send only known keys.

export type Int64 = string | number;

export interface User {
  id?: string;
  username?: string;
  role?: string;
  avatarUrl?: string;
}

export interface LoginResponse {
  user?: User;
  accessToken?: string;
  refreshToken?: string;
  mfa?: unknown;
}

export interface RedeemInviteResponse {
  login?: LoginResponse;
  roomId?: string;
}

export interface Room {
  id?: string;
  name?: string;
  createdBy?: string;
  memberCount?: number;
  description?: string;
  createdAt?: Int64;
}

export interface MyRoom {
  room?: Room;
  role?: string;
  permissions?: Int64;
  relation?: string;
}

export interface PlaybackState {
  roomId?: string;
  playingMediaId?: string;
  playingPlaylistId?: string;
  position?: number;
  speed?: number;
  isPlaying?: boolean;
  updatedAt?: Int64;
  version?: Int64;
  targetHash?: string;
  generatedAtMillis?: Int64;
}

export interface GetRoomResponse {
  room?: Room;
  playbackState?: PlaybackState;
}

export interface Media {
  id?: string;
  roomId?: string;
  name?: string;
  sourceProvider?: string;
  position?: number;
  addedAt?: Int64;
  creatorId?: string;
}

export interface Playlist {
  id?: string;
  name?: string;
  itemCount?: number;
}

export interface ListPlaylistItemsResponse {
  playlists?: Playlist[];
  media?: Media[];
}

export interface PlaybackMedia {
  name?: string;
  url?: string;
  headers?: Record<string, string>;
  format?: string;
  expireAt?: Int64;
}

export interface PlaybackSubtitle {
  name?: string;
  language?: string;
  url?: string;
  headers?: Record<string, string>;
  format?: string;
}

export interface PlaybackInfo {
  medias?: PlaybackMedia[];
  defaultMediaIndex?: number;
  subtitles?: PlaybackSubtitle[];
  defaultSubtitleIndex?: number;
}

export interface Playback {
  mediaId?: string;
  playlistId?: string;
  roomId?: string;
  name?: string;
  playbackInfos?: Record<string, PlaybackInfo>;
  defaultMode?: string;
  durationSeconds?: number;
  playbackKind?: string;
}

export interface GetPlaybackResponse {
  playbackState?: PlaybackState;
  playback?: Playback;
}

export interface RoomInvite {
  id?: Int64;
  expiresAt?: Int64;
  maxUses?: number;
  uses?: number;
  revoked?: boolean;
  createdAt?: Int64;
}

export interface CreateInviteResponse {
  invite?: RoomInvite;
  token?: string;
}

export function toNumber(value: Int64 | undefined | null, fallback = 0): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return isFinite(n) ? n : fallback;
}
