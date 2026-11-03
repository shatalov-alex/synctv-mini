// Deep links into the Telegram Mini App. Bot username and app short name are
// build-time config (VITE_TG_BOT_USERNAME / VITE_TG_APP_SHORT_NAME). Without a short
// name the links target the bot's Main Mini App (`t.me/<bot>?startapp=...`).

export interface MiniAppConfig {
  botUsername: string;
  appShortName: string;
}

export const miniApp: MiniAppConfig = {
  botUsername: (import.meta.env.VITE_TG_BOT_USERNAME || '').replace(/^@/, ''),
  appShortName: import.meta.env.VITE_TG_APP_SHORT_NAME || '',
};

/** start_param prefix that marks a TV pairing launch instead of an invite token. */
export const PAIR_START_PREFIX = 'pair-';

export function miniAppLink(startParam: string, config: MiniAppConfig = miniApp): string | null {
  if (!config.botUsername) return null;
  const app = config.appShortName ? `/${config.appShortName}` : '';
  return `https://t.me/${config.botUsername}${app}?startapp=${encodeURIComponent(startParam)}`;
}

export function inviteLink(token: string, config: MiniAppConfig = miniApp): string | null {
  return miniAppLink(token, config);
}

export function telegramShareLink(url: string, text?: string): string {
  let link = `https://t.me/share/url?url=${encodeURIComponent(url)}`;
  if (text) link += `&text=${encodeURIComponent(text)}`;
  return link;
}

/**
 * Where the TV's QR code points. Inside Telegram the phone is already signed
 * in, so prefer the Mini App deep link; otherwise fall back to /pair on this origin.
 */
export function pairLink(code: string, origin: string, config: MiniAppConfig = miniApp): string {
  return miniAppLink(PAIR_START_PREFIX + code, config) || `${origin}/pair?code=${encodeURIComponent(code)}`;
}

export type StartIntent = { kind: 'none' } | { kind: 'invite'; token: string } | { kind: 'pair'; code: string };

export function parseStartParam(startParam: string | undefined | null): StartIntent {
  if (!startParam) return { kind: 'none' };
  if (startParam.indexOf(PAIR_START_PREFIX) === 0) {
    const code = startParam.slice(PAIR_START_PREFIX.length);
    return code ? { kind: 'pair', code } : { kind: 'none' };
  }
  return { kind: 'invite', token: startParam };
}
