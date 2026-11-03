/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Telegram bot username without "@", used for invite and TV pairing deep links. */
  readonly VITE_TG_BOT_USERNAME?: string;
  /** Mini App short name configured in BotFather (t.me/<bot>/<app>). */
  readonly VITE_TG_APP_SHORT_NAME?: string;
  /** API origin; empty means same origin as the page (the normal deployment). */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// hls.js ships no types for its "light" entry; it has the same API surface.
declare module 'hls.js/light' {
  export { default } from 'hls.js';
}
