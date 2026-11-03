# SyncTV lite client

A small web client for watching together: a Telegram Mini App for the owner
and invited guests, plus a `/tv` page for smart-TV browsers.

- Vite + Preact + TypeScript, with no UI kit. About 29 KB of gzipped app JS in
  total; each page loads only the chunks it needs.
- `<video>` plays files directly. HLS uses the browser's native support when
  available, otherwise `hls.js/light`, which is loaded only when needed
  (about 117 KB gz).
- The output targets ES2017 (Chromium 63+, Safari 11.1+): no optional
  chaining, no top-level await.

## Routes

| Path | Who | What |
|---|---|---|
| `/` | Mini App | Signs you in (Telegram initData, an invite redeem, or a stored session), then shows your rooms. Admins can create a room. A guest with a single room goes straight into it. |
| `/room/:id` | Mini App | Player and controls (play/pause, ±10 s, seek, speed, next/prev, Sync, fullscreen), playlist, add by URL (creator), invite links (creator), and "Watch on TV": claim a TV code; the creator also gets the paired-TV list with Unpair. Telegram's BackButton returns to `/`. |
| `/tv` | TV browser | Shows a pairing code and QR code, then plays full screen. Remote: OK/Space/Enter toggles play/pause, ◀ ▶ seek ±10 s, media keys work, and pressing the red key twice unpairs. When the TV is unpaired from the phone, kicked, or its refresh token stops working, it goes back to the pairing screen. |
| `/pair?code=…` | Phone | Choose one of your rooms and claim the TV's code. |

Launch parameters (Telegram `startapp`):

- `startapp=<inviteToken>` redeems the invite (`POST /api/invites/redeem`; the
  token comes from the signed `start_param`) and opens that room. A current
  member can reopen a spent link.
- `startapp=pair-<code>` opens `/pair?code=<code>`. This is what the TV's QR
  code points to when the bot is configured. Without the bot, the QR points
  to `https://<origin>/pair?code=…`.

## Build-time config (Vite env)

| Variable | Purpose |
|---|---|
| `VITE_TG_BOT_USERNAME` | Bot username without `@`, for `https://t.me/<bot>/<app>?startapp=…` links |
| `VITE_TG_APP_SHORT_NAME` | Mini App short name from BotFather |
| `VITE_API_BASE` | API origin. Leave it empty when the server serves the client (the normal setup). |

```sh
VITE_TG_BOT_USERNAME=my_synctv_bot VITE_TG_APP_SHORT_NAME=watch pnpm build
```

## Development

```sh
pnpm install
pnpm dev                       # proxies /api and /ws to DEV_API_TARGET (default http://127.0.0.1:8080)
VITE_MOCK_TV=1 pnpm dev        # also mocks /api/tv/pairings* in memory
pnpm typecheck && pnpm test && pnpm build
pnpm vendor:telegram           # refresh public/telegram-web-app.js
```

The TV pairing mock gives the TV the claiming phone's own access token. It
exists only to exercise the UI flow and is never part of a build.

## Serving from the SynCTV server

The server serves a web UI from disk when built with the `web-ui` or
`web-ui-dynamic` cargo feature (`make release` uses `web-ui`) and
`server.web_ui_directory` is set:

```yaml
server:
  web_ui_directory: /srv/synctv/lite-client/dist   # absolute path recommended
```

or `SYNCTV_SERVER_WEB_UI_DIRECTORY=/srv/synctv/lite-client/dist`.

How the server handles requests (`synctv-api-http/src/http/web_ui.rs`):

- Existing files under the directory are served as they are. `/api/*`,
  `/ws/*` and `/grpc/*` are never served from it.
- Navigations to paths without a dot (`Accept: text/html`, or no `Accept`
  header) fall back to `index.html`. So `/`, `/room/room_xxx`, `/tv` and
  `/pair?code=…` all work as SPA deep links. Avoid dots in client routes.
- Disk assets are sent with `Cache-Control: no-store` and no compression.
  Put a compressing reverse proxy in front if bandwidth matters. hls.js is
  about 374 KB raw, and the TV only fetches it for HLS on browsers without
  native HLS.

### CSP and framing

The server's default CSP (`security_headers_middleware`) is
`script-src 'self'`. This means:

- `telegram-web-app.js` is **vendored** in `public/` and served from the same
  origin. It cannot be loaded from telegram.org. It loads only when Telegram
  launched the page, never on `/tv`.
- There are no inline scripts. The QR code is a `data:` image, which
  `img-src` allows.
- `frame-ancestors 'none'` and `X-Frame-Options: DENY` stop the Mini App from
  working in Telegram **Web** (web.telegram.org loads Mini Apps in an iframe).
  The native iOS, Android and desktop apps use webviews and are not affected.
  Fixing Telegram Web needs a server change, or a proxy that rewrites those
  two headers for HTML responses.

## Sync

`src/sync/` ports the official SynCTV Flutter client's playback sync:

- **Socket.** JSON text frames (`format=json`) over
  `/ws/rooms/{room}?ticket=…`, with a fresh ticket from `POST /api/tickets`
  on every connect and reconnect. Enums are integers and int64 values are
  strings. Heartbeat every 25 s. Reconnect delay is 2 s × attempt, capped at
  10 s. Each connect resubscribes to `playback_state` and `playback` (as
  `PUSH_SNAPSHOT`).
- **Clock.** One NTP-style `/api/public/time` sample every 30 s, without
  smoothing. The expected position is the server's `generatedAtMillis` plus
  the clock offset.
- **Correction.** Hard seek only when drift > 1.2 s, or ≥ 0.2 s for forced
  syncs: join, media change, rollback, and the Sync button. A check runs every
  2 s and on each server event, followed by an 800 ms cooldown. Changes are
  applied in the order rate → pause → seek → play. There is no
  `playbackRate` nudging and no "wait for others".
- **Commands.** Only UI gestures send commands; player events never do. Each
  command carries a UUID v4 `clientOperationId` and `clientTimeMillis`. Our
  own acks are stored but not re-applied. A rejected command rolls back with
  a forced sync. Conflicts (code 2003) roll back silently; other errors are
  shown.
- **Autoplay.** If autoplay is blocked, playback is retried muted, and the next
  user gesture unmutes.
- **Next/previous.** These go over HTTP, and the response is ignored.

Choices made where the spec was ambiguous (also noted in the code):

1. **Client profile.** Uses `profile_version: 2` (this matches the server
   constant) with the web profile's shape. It advertises only what this
   client can play: progressive files, plus HLS through MSE, ManagedMediaSource
   or native playback. It does not advertise DASH, FLV or MPEG-TS.
2. **Conflict code.** Treated as 2003. That mapping is not verified against the
   server.
3. **Event order.** The `playback_state` and `playback` events are accepted in
   either order. The resolved source is used only when its media and playlist
   ids match the current state.
4. **Position.** Read from `video.currentTime` directly. There is no polling
   lag, and the 1.2 s band makes this safe.
5. **Heartbeat ack.** Ignored, as in the official client.
6. **Failed time sample.** Resets the offset to 0, matching the official
   client. If that causes trouble, keep the last good offset instead in
   `ServerClock.sample`.

Remaining differences from the official client: seek steps are ±10 s (the
official client uses ±5 s), and the client reloads a source at most 3 times
after player errors.
