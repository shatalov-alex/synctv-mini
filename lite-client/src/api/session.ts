// Token persistence and JWT expiry bookkeeping. Tokens never leave this module
// except as the Authorization header and the refresh request body.

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Reads the `exp` claim (seconds) of a JWT without verifying it; null if absent. */
export function jwtExpiry(token: string): number | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '==='.slice((base64.length + 3) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/** Seconds of access-token lifetime left at `nowMs`; Infinity when the token has no exp. */
export function secondsLeft(token: string, nowMs: number): number {
  const exp = jwtExpiry(token);
  return exp === null ? Infinity : exp - nowMs / 1000;
}

/** Refresh this long before expiry (access tokens live 1 h). */
export const REFRESH_MARGIN_SECONDS = 120;

export function shouldRefresh(token: string, nowMs: number): boolean {
  return secondsLeft(token, nowMs) < REFRESH_MARGIN_SECONDS;
}

function memoryStorage(): KeyValueStorage {
  const map: Record<string, string> = {};
  return {
    getItem: (k) => (k in map ? map[k] : null),
    setItem: (k, v) => {
      map[k] = v;
    },
    removeItem: (k) => {
      delete map[k];
    },
  };
}

export function defaultStorage(): KeyValueStorage {
  try {
    const probe = '__synctv_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return memoryStorage();
  }
}

export class TokenStore {
  private tokens: Tokens | null = null;
  private listeners: Array<(tokens: Tokens | null) => void> = [];

  constructor(
    private readonly key: string,
    private readonly storage: KeyValueStorage = memoryStorage(),
  ) {
    try {
      const raw = storage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Tokens>;
        if (typeof parsed.accessToken === 'string' && parsed.accessToken) {
          this.tokens = {
            accessToken: parsed.accessToken,
            refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : '',
          };
        }
      }
    } catch {
      this.tokens = null;
    }
  }

  get(): Tokens | null {
    return this.tokens;
  }

  set(tokens: Tokens | null): void {
    this.tokens = tokens;
    try {
      if (tokens) this.storage.setItem(this.key, JSON.stringify(tokens));
      else this.storage.removeItem(this.key);
    } catch {
      // Storage full or blocked: keep the in-memory session.
    }
    for (const listener of this.listeners) listener(tokens);
  }

  clear(): void {
    this.set(null);
  }

  subscribe(listener: (tokens: Tokens | null) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
}
