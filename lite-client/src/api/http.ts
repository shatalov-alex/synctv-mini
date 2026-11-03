// Minimal fetch wrapper: bearer auth, proactive refresh before expiry, a single
// refresh-and-retry on 401, and google.rpc.Status error decoding.
//
// Never log request bodies, responses or headers here: they carry initData and tokens.
import { REFRESH_MARGIN_SECONDS, secondsLeft, shouldRefresh, TokenStore, type Tokens } from './session';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** google.rpc.Code from the body, when present. */
    readonly code?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** Origin prefix for API paths; '' = same origin. */
  base?: string;
  store: TokenStore;
  fetch?: FetchLike;
  now?: () => number;
  /**
   * Called when the refresh token is rejected. May obtain a brand-new session
   * (e.g. Telegram initData sign-in) and return it; null signs the user out.
   */
  reauthenticate?: () => Promise<Tokens | null>;
  onSignedOut?: () => void;
}

export interface RequestOptions {
  /** Attach the bearer token (default true). */
  auth?: boolean;
  query?: Record<string, string | number | boolean | undefined>;
  /**
   * Refresh and retry once on 401 (default true). Disable for endpoints whose
   * 401 is not about the session (TV claim lockout) so a retry can't count
   * as another failed attempt.
   */
  retryOn401?: boolean;
}

type RefreshOutcome = 'ok' | 'rejected' | 'failed';

export class ApiClient {
  readonly store: TokenStore;
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private refreshing: Promise<RefreshOutcome> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: ApiClientOptions) {
    this.store = options.store;
    this.base = options.base ?? '';
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
  }

  setReauthenticate(fn: ApiClientOptions['reauthenticate']): void {
    this.options.reauthenticate = fn;
  }

  setOnSignedOut(fn: ApiClientOptions['onSignedOut']): void {
    this.options.onSignedOut = fn;
  }

  url(path: string, query?: RequestOptions['query']): string {
    let url = this.base + path;
    if (query) {
      const params: string[] = [];
      for (const key of Object.keys(query)) {
        const value = query[key];
        if (value !== undefined && value !== '') {
          params.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
        }
      }
      if (params.length) url += (url.indexOf('?') >= 0 ? '&' : '?') + params.join('&');
    }
    return url;
  }

  async request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    const auth = opts.auth !== false;
    if (auth) {
      const tokens = this.store.get();
      if (tokens && tokens.refreshToken && shouldRefresh(tokens.accessToken, this.now())) {
        await this.refresh();
      }
    }
    let response = await this.send(method, path, body, opts, auth);
    if (response.status === 401 && auth && opts.retryOn401 !== false && this.store.get()) {
      const outcome = await this.refresh();
      if (outcome === 'ok') response = await this.send(method, path, body, opts, auth);
    }
    return this.decode<T>(response);
  }

  /**
   * Refreshes the access token once, even if many callers ask at the same time.
   * 'rejected' means the session is gone (after trying reauthentication).
   */
  refresh(): Promise<RefreshOutcome> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().then(
        (outcome) => {
          this.refreshing = null;
          this.schedule();
          return outcome;
        },
        () => {
          this.refreshing = null;
          return 'failed' as RefreshOutcome;
        },
      );
    }
    return this.refreshing;
  }

  /** Stores a fresh session and arms the proactive refresh timer. */
  signIn(tokens: Tokens): void {
    this.store.set(tokens);
    this.schedule();
  }

  signOut(): void {
    this.store.clear();
    this.cancelTimer();
  }

  /** Arms a timer that refreshes REFRESH_MARGIN_SECONDS before expiry. */
  schedule(): void {
    this.cancelTimer();
    const tokens = this.store.get();
    if (!tokens || !tokens.refreshToken) return;
    const left = secondsLeft(tokens.accessToken, this.now());
    if (!isFinite(left)) return;
    const delayMs = Math.max(5, left - REFRESH_MARGIN_SECONDS) * 1000;
    // setTimeout overflows above ~24.8 days; tokens live 1 h anyway.
    this.timer = setTimeout(() => void this.refresh(), Math.min(delayMs, 2 ** 31 - 1));
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async doRefresh(): Promise<RefreshOutcome> {
    const tokens = this.store.get();
    let rejected = !tokens || !tokens.refreshToken;
    if (!rejected && tokens) {
      let response: Response;
      try {
        response = await this.send('POST', '/api/auth/refresh', { refreshToken: tokens.refreshToken }, {}, false);
      } catch {
        return 'failed';
      }
      if (response.ok) {
        const body = (await response.json()) as { accessToken?: string; refreshToken?: string };
        if (body.accessToken) {
          this.store.set({ accessToken: body.accessToken, refreshToken: body.refreshToken || tokens.refreshToken });
          return 'ok';
        }
        rejected = true;
      } else if (response.status === 400 || response.status === 401 || response.status === 403) {
        rejected = true;
      } else {
        return 'failed';
      }
    }
    if (this.options.reauthenticate) {
      try {
        const fresh = await this.options.reauthenticate();
        if (fresh) {
          this.store.set(fresh);
          return 'ok';
        }
      } catch {
        // fall through to sign-out
      }
    }
    this.store.clear();
    if (this.options.onSignedOut) this.options.onSignedOut();
    return 'rejected';
  }

  private send(method: string, path: string, body: unknown, opts: RequestOptions, auth: boolean): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const tokens = auth ? this.store.get() : null;
    if (tokens) headers.Authorization = `Bearer ${tokens.accessToken}`;
    return this.fetchImpl(this.url(path, opts.query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
    });
  }

  private async decode<T>(response: Response): Promise<T> {
    const text = await response.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    if (!response.ok) {
      const status = data as { code?: unknown; message?: unknown } | undefined;
      const message =
        status && typeof status.message === 'string' && status.message
          ? status.message
          : `HTTP ${response.status}`;
      throw new ApiError(response.status, message, status && typeof status.code === 'number' ? status.code : undefined);
    }
    return (data === undefined ? {} : data) as T;
  }
}
