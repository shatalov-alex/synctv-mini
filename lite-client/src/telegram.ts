// Telegram Mini App bridge. The official script is served same-origin
// (public/telegram-web-app.js) because the server's CSP only allows 'self'
// scripts; it is only loaded when the page was launched by Telegram.
//
// Never log initData: it is a bearer credential for /api/auth/telegram.

export interface TgBackButton {
  show(): void;
  hide(): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
}

export interface TgWebApp {
  initData: string;
  initDataUnsafe: { start_param?: string; user?: { id: number; first_name?: string; username?: string } };
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  themeParams: Record<string, string | undefined>;
  ready(): void;
  expand(): void;
  close(): void;
  BackButton: TgBackButton;
  openTelegramLink(url: string): void;
  openLink(url: string): void;
  showAlert?(message: string): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  isVersionAtLeast?(version: string): boolean;
  onEvent(event: string, cb: () => void): void;
  disableVerticalSwipes?(): void;
  HapticFeedback?: { impactOccurred(style: string): void };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
    TelegramWebviewProxy?: unknown;
  }
}

let webApp: TgWebApp | null = null;

/** True when Telegram opened this page (launch params in the hash, or a reload inside the webview). */
export function launchedByTelegram(): boolean {
  try {
    if (/tgWebApp(Data|Version|Platform)=/.test(location.hash)) return true;
    if (window.TelegramWebviewProxy) return true;
    return !!window.sessionStorage.getItem('__telegram__initParams');
  } catch {
    return false;
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(script);
  });
}

/** Loads the bridge if launched by Telegram; resolves null elsewhere (browser, TV). */
export async function initTelegram(): Promise<TgWebApp | null> {
  if (!launchedByTelegram()) return null;
  try {
    await loadScript('/telegram-web-app.js');
  } catch {
    return null;
  }
  const app = window.Telegram && window.Telegram.WebApp;
  if (!app || !app.initData) return null;
  webApp = app;
  document.documentElement.classList.add('tg');
  applyTheme(app);
  app.onEvent('themeChanged', () => applyTheme(app));
  app.ready();
  app.expand();
  if (app.disableVerticalSwipes && supports(app, '7.7')) app.disableVerticalSwipes();
  return app;
}

export function telegram(): TgWebApp | null {
  return webApp;
}

function supports(app: TgWebApp, version: string): boolean {
  return !!app.isVersionAtLeast && app.isVersionAtLeast(version);
}

/**
 * telegram-web-app.js already exposes --tg-theme-* CSS variables; we only mirror
 * the color scheme and paint Telegram's own header/background to match.
 */
function applyTheme(app: TgWebApp): void {
  document.documentElement.setAttribute('data-scheme', app.colorScheme);
  const bg = app.themeParams.bg_color;
  if (bg && supports(app, '6.1')) {
    if (app.setHeaderColor) app.setHeaderColor('bg_color');
    if (app.setBackgroundColor) app.setBackgroundColor(bg);
  }
}

/** Shows Telegram's BackButton while mounted; returns a cleanup function. */
export function useBackButtonEffect(onBack: () => void): () => void {
  const app = webApp;
  if (!app || !supports(app, '6.1')) return () => {};
  app.BackButton.onClick(onBack);
  app.BackButton.show();
  return () => {
    app.BackButton.offClick(onBack);
    app.BackButton.hide();
  };
}

/** Opens a t.me link inside Telegram when possible, else in a new tab. */
export function openTelegramLink(url: string): void {
  if (webApp && /^https:\/\/t\.me\//.test(url)) webApp.openTelegramLink(url);
  else window.open(url, '_blank', 'noopener');
}

export function haptic(): void {
  try {
    if (webApp && webApp.HapticFeedback && supports(webApp, '6.1')) webApp.HapticFeedback.impactOccurred('light');
  } catch {
    // ignore
  }
}
