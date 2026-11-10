# SyncTV Mini

Watch videos together, in sync, from a Telegram Mini App, on a server that runs on your
own computer.

SyncTV Mini is a fork of [SyncTV](https://github.com/synctv-org/synctv), cut down for a
small private setup: one owner, a few invited guests, and a TV. You add a video link to a
room, open the room in Telegram, and everyone's player stays on the same frame. Pause,
seek or switch episodes on one phone, and every screen follows.

It runs on one machine, such as a home computer, with Docker. A Cloudflare tunnel makes
it reachable from anywhere without opening ports on your router.

## What you get

- **A Telegram Mini App client** (`lite-client/`) that is small and fast, about 38 KB of
  gzipped JavaScript. You sign in with Telegram, with no passwords.
- **Synchronized playback** of direct video links (MP4, WebM, HLS). The server can proxy
  a link, so links tied to one IP address play for everyone.
- **Invite links.** You send one in Telegram, and your guest taps it and is in the room.
  Each link can expire after an hour or a month, or never. It can work for one person, a
  few, or anyone who has it. Guests can control playback but can't add or delete videos.
  Someone you remove from a room can't come back on an old link.
- **TV mode.** Open `/tv` in the TV's browser, scan the QR code with your phone, and the TV
  joins the room. It plays full screen and works with the TV remote. Your phone becomes a
  remote control if you want it to.
- **Resume.** Each room remembers where it stopped in every video.
- **Waiting for slow devices.** If a TV or phone is still loading, the room pauses until
  it catches up.
- **A service API** for your own scripts and bots: create rooms, add videos, and see
  what's playing. See [docs/service-api.md](docs/service-api.md).

## How it differs from SyncTV

The server is SyncTV's (Rust, PostgreSQL, Redis), with these changes:

| | SyncTV | SyncTV Mini |
|---|---|---|
| Client | Flutter app and web UI | Telegram Mini App and TV page |
| Sign-in | Passwords, OAuth, passkeys, email | Telegram, plus invite links for guests |
| Who creates rooms | Any user | Admins only (`SYNCTV_ROOMS_USERS_CAN_CREATE`) |
| Live streaming (RTMP, WHIP) | On | Off (`SYNCTV_LIVESTREAM_ENABLED`) |
| gRPC API and clustering | Built in | Left out of the build (`grpc` cargo feature) |
| ffmpeg in the image | Yes | No (`SYNCTV_RUNTIME_FFMPEG`) |
| Docker image | about 1 GB | about 410 MB |

Chat, voice chat and the admin panel still exist on the server, but the Mini App doesn't
use them. Every change is a setting or a build option, so you can switch any of it back.
The fork follows upstream releases: v1.0.14 is merged.

## What you need

- **A computer that stays on**, with [Docker](https://docs.docker.com/get-docker/).
  Building the server image takes a lot of memory: give Docker at least 8 GB, or 12 GB if
  other containers are running. The server itself uses about 300 MB.
- **A Telegram bot.** Create one with [@BotFather](https://t.me/BotFather).
- **A public HTTPS address.** Telegram only opens Mini Apps over HTTPS. This guide uses a
  [Cloudflare tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/),
  which needs a domain on Cloudflare. Any HTTPS reverse proxy also works.
- **Node.js 20.19+ and pnpm** to build the client.

## Set it up

### 1. Create the bot

1. In [@BotFather](https://t.me/BotFather), send `/newbot` and keep the **token** it gives
   you.
2. Find your own numeric Telegram id, for example with
   [@userinfobot](https://t.me/userinfobot). That account becomes the admin.
3. In BotFather, open your bot → **Bot Settings** → **Configure Mini App** and set the URL
   to your public address, for example `https://tv.example.com`. Invite links and the TV's
   QR code open this Main Mini App.

### 2. Get the code and configure it

```sh
git clone https://github.com/<you>/synctv-mini.git
cd synctv-mini
cp .env.postgres.example .env.postgres
cp .env.redis.example .env.redis
cp .env.synctv.example .env.synctv
cp docker-compose.override.example.yml docker-compose.override.yml
```

Fill in the files:

- **`.env.postgres`:** set `POSTGRES_PASSWORD`.
- **`.env.redis`:** set `REDIS_PASSWORD`.
- **`.env.synctv`:**
  - Set `SYNCTV_DATABASE_URL` and `SYNCTV_REDIS_URL` with the two passwords above.
  - Generate every secret the file asks for. Each one has its own `openssl` command next
    to it.
  - Set the Telegram settings and the trusted proxies:

    ```sh
    SYNCTV_TELEGRAM_BOT_TOKEN=123456:ABC...
    SYNCTV_TELEGRAM_ADMIN_USER_ID=123456789
    SYNCTV_SERVER_TRUSTED_PROXIES=192.168.65.1,172.16.0.0/12
    ```

    `SYNCTV_SERVER_TRUSTED_PROXIES` makes per-visitor sign-in limits work behind the tunnel.
    The same value works with Docker on Linux.
- **`docker-compose.override.yml`:** set `SYNCTV_TELEGRAM_WEB_APP_URL` to your public
  address.

Keep `.env.synctv` safe and unchanged across upgrades. If you lose its secrets, you lose
access to the stored data.

### 3. Build

```sh
docker build \
  --build-arg SYNCTV_BUILD_NO_DEFAULT_FEATURES=true \
  --build-arg SYNCTV_BUILD_FEATURES=tls-aws-lc,tls-webpki-roots,mimalloc,openapi,web-ui-dynamic \
  --build-arg SYNCTV_RUNTIME_FFMPEG=false \
  -t synctv-mini:latest .

cd lite-client && pnpm install && pnpm build && cd ..
```

The first image build takes a while, 15–30 minutes. Later builds reuse the cache. Keep
`web-ui-dynamic` in the feature list, because without it the server doesn't serve the
client.

### 4. Start

```sh
docker compose up -d
docker compose ps        # synctv-app should become "healthy"
```

The server listens on `127.0.0.1:8080` only, so it can't be reached from your local
network directly. The tunnel is the way in.

### 5. Open it to the internet

```sh
cloudflared tunnel login
cloudflared tunnel create synctv
cloudflared tunnel route dns synctv tv.example.com
cloudflared tunnel run --url http://localhost:8080 synctv
```

To keep the tunnel running after a reboot, install it as a service
(`cloudflared service install`).

### 6. Use it

1. Open your bot in Telegram and tap **Open** (or the menu button). You're signed in as the
   admin.
2. Create a room (type a name at the bottom of the room list), then tap **Add video** and
   paste a link.
3. Tap **Invite** to make a link, then send it to someone. They tap it and are in.
4. For a TV, open `https://tv.example.com/tv` in its browser. In the room on your phone,
   tap **Watch on TV** and scan the code.

As the admin, you can also send `/invite` in a chat with the bot to get an invite link for
one of your rooms.

## Settings

These are the settings SyncTV Mini adds or changes. Upstream's settings all still apply;
see `.env.synctv.example` and `synctv.example.yaml`.

| Variable | Default | Meaning |
|---|---|---|
| `SYNCTV_TELEGRAM_BOT_TOKEN` | empty | Bot token. Empty turns Telegram sign-in off. |
| `SYNCTV_TELEGRAM_ADMIN_USER_ID` | `0` | Telegram id that signs in as the admin. |
| `SYNCTV_TELEGRAM_WEB_APP_URL` | empty | Public address for the bot's buttons. |
| `SYNCTV_TELEGRAM_BOT_USERNAME` | ask Telegram | Bot username for invite and TV links. |
| `SYNCTV_TELEGRAM_MINI_APP_SHORT_NAME` | empty | Use `t.me/<bot>/<name>` links instead of the Main Mini App. |
| `SYNCTV_ROOMS_USERS_CAN_CREATE` | `false` | Let non-admin accounts create rooms. |
| `SYNCTV_LIVESTREAM_ENABLED` | `true` (`false` in the override) | Live streaming and its RTMP port. |
| `SYNCTV_MEDIA_DIRECT_URL_DEFAULT_PROXY_MODE` | `auto` | `only` sends every new link through the server, for links bound to one IP. |
| `SYNCTV_SECURITY_SSRF_ENABLED` | `true` in the example | Stop the server from fetching addresses on your local network. |
| `SYNCTV_SERVICE_API_KEY` | empty | Key for the [service API](docs/service-api.md). |

## Backups

Everything lives in Docker volumes. Back up the database regularly:

```sh
mkdir -p backups
docker exec synctv-postgres pg_dump -U synctv synctv | gzip > backups/synctv-$(date +%F).sql.gz
```

To restore it into an empty database:

```sh
gunzip -c backups/synctv-YYYY-MM-DD.sql.gz | docker exec -i synctv-postgres psql -U synctv -d synctv
```

Back up before you change Docker Desktop's disk settings: resizing its disk image
deletes every container, image and volume.

## Updating

```sh
git pull
docker build ... -t synctv-mini:latest .   # same command as in step 3
cd lite-client && pnpm build && cd ..
docker compose up -d synctv
```

Database migrations run on start. A client rebuild goes live without a restart, because
the server reads `lite-client/dist` from disk.

## Development

- Server: Rust (see `rust-toolchain.toml`). Run `cargo test --workspace`. Tests marked
  `#[ignore]` need Docker, because they start their own PostgreSQL.
- Client: see [lite-client/README.md](lite-client/README.md).

## Credits and license

SyncTV Mini is built on [SyncTV](https://github.com/synctv-org/synctv) by its authors and
contributors. Their work is the server, the providers and the sync engine; this fork adds
the Telegram client and trims the rest.

MIT, like upstream. See [LICENSE](LICENSE).
