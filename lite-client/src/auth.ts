// Session bootstrap for the Mini App / phone surfaces.
import { ApiClient, ApiError } from './api/http';
import { getMe, loginWithTelegram, redeemInvite, tokensFromLogin } from './api/endpoints';
import { defaultStorage, TokenStore } from './api/session';
import type { User } from './api/types';
import { parseStartParam, type StartIntent } from './links';
import type { TgWebApp } from './telegram';

const API_BASE = import.meta.env.VITE_API_BASE || '';

export function createApi(storageKey: string): ApiClient {
  return new ApiClient({ base: API_BASE, store: new TokenStore(storageKey, defaultStorage()) });
}

/** Phone / Mini App session (the TV keeps its own, see pages/Tv.tsx). */
export const api = createApi('synctv-lite.session');

export interface BootResult {
  me: User | null;
  /** Room to open right away (from an invite). */
  roomId?: string;
  intent: StartIntent;
  error?: string;
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return fallback;
    return error.message;
  }
  return 'Network error. Check your connection and try again.';
}

export async function bootstrap(tg: TgWebApp | null): Promise<BootResult> {
  const intent = parseStartParam(tg ? tg.initDataUnsafe.start_param : null);
  let inviteError: string | undefined;

  if (tg) {
    const initData = tg.initData;
    // Reauthenticate with the launch initData when the refresh token dies.
    // initData is accepted for ~1 h after launch (telegram.init_data_max_age_secs).
    api.setReauthenticate(async () => {
      try {
        if (intent.kind === 'invite') return tokensFromLogin((await redeemInvite(api, initData)).login);
        return tokensFromLogin(await loginWithTelegram(api, initData));
      } catch {
        return null;
      }
    });

    if (intent.kind === 'invite') {
      try {
        // Token omitted: the server takes it from start_param inside the signed initData.
        const res = await redeemInvite(api, initData);
        const tokens = tokensFromLogin(res.login);
        if (tokens) {
          api.signIn(tokens);
          return { me: (res.login && res.login.user) || null, roomId: res.roomId, intent };
        }
      } catch (error) {
        inviteError = describe(error, 'This invite link is no longer valid. Ask for a new one.');
      }
    }
  }

  if (api.store.get()) {
    try {
      const me = await getMe(api);
      api.schedule();
      return { me, intent, error: inviteError };
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        return { me: null, intent, error: describe(error, 'Sign-in failed.') };
      }
      api.signOut();
    }
  }

  if (tg) {
    try {
      const login = await loginWithTelegram(api, tg.initData);
      const tokens = tokensFromLogin(login);
      if (tokens) {
        api.signIn(tokens);
        return { me: login.user || null, intent, error: inviteError };
      }
    } catch (error) {
      return {
        me: null,
        intent,
        error: inviteError || describe(error, 'You need an invite link to join. Ask the room owner to send you one.'),
      };
    }
  }

  return {
    me: null,
    intent,
    error: inviteError || 'Open this app from Telegram to sign in.',
  };
}
