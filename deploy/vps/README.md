# Moving SyncTV to a VPS

The VPS starts with an empty database. Rooms, playlists and sign-ins are not carried over.

The app, Postgres and Redis publish no ports. Traffic arrives through the existing Cloudflare
tunnel, so the address stays `synctv.shatalov.co` and neither DNS nor BotFather changes.

## Server

Debian 12+ or Ubuntu 22.04+, with root SSH.

| | Minimum | Why |
|---|---|---|
| RAM | 2 GB; 1 GB can work with the swap the setup adds | About 300 MB idle and 565 MB with three proxied viewers and a full video cache, before the OS and Docker |
| Disk | 10 GB | Images, a small database and capped logs |
| Traffic | Upload at least 3 Mbps per viewer of a 720p movie | Default proxy mode 2 sends all video through the server |
| Monthly traffic | About 2.4 GB per viewer-hour, counting download and upload | Check the plan's limit |

## Steps

Build the bundle on the development machine. Use `arm64` for an ARM server; `uname -m` on the
server tells you: `x86_64` is amd64, `aarch64` is arm64.

```sh
deploy/vps/make-bundle.sh amd64
scp deploy/vps/out/synctv-vps-amd64.tar.gz root@VPS:/opt/
```

The archive holds live secrets. Delete it from `/opt` after unpacking.

Prepare the server and start the app. This takes no public traffic yet.

```sh
ssh root@VPS
cd /opt && tar -xzf synctv-vps-amd64.tar.gz && rm synctv-vps-amd64.tar.gz
cd synctv
./prepare-server.sh
./install.sh
```

Move the bot next. It must call `http://synctv:8080`: the service API refuses requests through
the tunnel with 403. Its compose file joins the `synctv-server_synctv` network, as described in
`docs/service-api.md`. The service key has not changed. Rooms it remembers no longer exist.

Switch traffic. Stop the old tunnel first, because Cloudflare spreads requests across every
running connector of a tunnel, so two machines would answer at random.

```sh
# on the old machine: stop cloudflared, then
./install.sh go-live     # on the VPS
```

Then open the Mini App, add a movie, and play it on two devices.

## Going back

```sh
./install.sh go-dark     # on the VPS
# on the old machine: start cloudflared again
```

The old machine keeps its own database, so it returns as it was when traffic left it. Anything
created on the VPS stays on the VPS.

## Later

- Logs: `docker logs -f synctv-app`
- Status: `docker compose -p synctv-server ps`
- New server image: run `make-bundle.sh`, copy `image.tar.gz` to the VPS, then
  `gunzip -c image.tar.gz | docker load && docker compose -p synctv-server up -d synctv`.
  Keep the VPS's `env/` directory: the bundle's new secrets do not match its database.
- New client only: replace the contents of `lite-client/`. No restart is needed.
- Admin password: `SYNCTV_BOOTSTRAP_ROOT_PASSWORD` in `env/synctv.env`.
