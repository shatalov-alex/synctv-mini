# Service API key

The service API key lets another app (typically another Docker container on the
same machine) manage SyncTV rooms and playlists over the normal HTTP API and read
what every active room is playing, without a Telegram sign-in or an expiring JWT.

- It is sent as `Authorization: Bearer stk_...` and works on **every**
  authenticated endpoint a signed-in user can call (rooms, media/playlist,
  playback, invites, TVs, ...). JWTs keep working as before.
- It acts as **one** account (see [Who the key acts as](#who-the-key-acts-as)), so
  everything it creates is owned by that account.
- It is only accepted from the internal network, never through the Cloudflare
  tunnel (see [Network rules](#network-rules)).
- It also unlocks the [timeline](#timeline) endpoints.

## Setup

Generate a key (it must start with `stk_` and be at least 36 characters):

```sh
echo "stk_$(openssl rand -hex 32)"
```

Add it to `.env.synctv` and recreate the `synctv` container:

```sh
SYNCTV_SERVICE_API_KEY=stk_...
# Optional, these are the defaults:
# SYNCTV_SERVICE_API_ACT_AS=telegram_admin
# SYNCTV_SERVICE_API_ALLOWED_NETWORKS=127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7
# Proxy new direct-URL media through the server unless the request says otherwise:
# SYNCTV_MEDIA_DIRECT_URL_DEFAULT_PROXY_MODE=only
```

| Config (`synctv.yaml`)               | Environment                                        | Default            |
| ------------------------------------ | -------------------------------------------------- | ------------------ |
| `service_api.key`                    | `SYNCTV_SERVICE_API_KEY` (or `..._KEY_FILE`)       | empty = disabled   |
| `service_api.act_as`                 | `SYNCTV_SERVICE_API_ACT_AS`                        | `telegram_admin`   |
| `service_api.allowed_networks`       | `SYNCTV_SERVICE_API_ALLOWED_NETWORKS` (comma list) | loopback, RFC 1918, `fc00::/7` |
| `media.direct_url_default_proxy_mode`| `SYNCTV_MEDIA_DIRECT_URL_DEFAULT_PROXY_MODE`       | `auto`             |

A malformed key stops the server at startup (the error never contains the key).
The server keeps only a SHA-256 of the key, compares presented keys in constant
time and never logs them. Every keyed request is logged at info level
(`target: synctv::service_api`) with method, path, status and peer address.

At startup the log says `Service API key enabled` with the account it acts as,
or warns that `service_api.act_as` does not resolve.

## Network rules

A keyed request is refused with **403** when

- it carries a `Cf-Ray` or `Cf-Connecting-Ip` header, i.e. it came through the
  Cloudflare tunnel, or
- the TCP peer address (the socket, not `X-Forwarded-For` or other headers) is
  outside `service_api.allowed_networks`.

So call SyncTV directly over the Docker network, e.g. `http://synctv:8080`, and
never through the public tunnel hostname. Join your app's container to SyncTV's
network. With this repository's `docker-compose.yml` that network is
`synctv-server_synctv` (compose project `synctv-server`, network `synctv`;
check with `docker network ls`):

```yaml
# docker-compose.yml of the other app
services:
  my-app:
    image: my-app:latest
    environment:
      SYNCTV_URL: http://synctv:8080
      SYNCTV_SERVICE_API_KEY: ${SYNCTV_SERVICE_API_KEY}
    networks:
      - synctv

networks:
  synctv:
    external: true
    name: synctv-server_synctv
```

`synctv` is the service name of the SyncTV container on that network. A wrong
key gets **401**; no key configured on the server also gets 401.

## Who the key acts as

`service_api.act_as` picks the account:

- `telegram_admin` (default): the account the Telegram admin
  (`telegram.admin_user_id`) acts as in the Mini App and the bot: the account
  their Telegram id was linked to on Mini App sign-in, otherwise
  `telegram.admin_username` (default `bootstrap.root_username`), and it must be an
  active admin/root. Rooms the app creates therefore belong to the admin, who can
  manage them from the Mini App too. With `telegram.admin_user_id` unset there is
  no Telegram admin and the key cannot be used.
- any other value: that username (must exist and not be banned or deleted).

If the account cannot be resolved, keyed requests get **503** with a message
naming `service_api.act_as`. Permissions are that account's permissions: an
admin/root account can do what the admin can do in the Mini App.

## Requests

JSON uses the proto3 JSON mapping: camelCase fields, **enums as integers**,
64-bit integers as strings, and fields with default values (false, 0, empty)
are omitted from responses. Errors are `google.rpc.Status` JSON
(`{"code": 16, "message": "...", "details": [...]}`). IDs look like `room_...`,
`med_...`, `pl_...`.

```sh
SYNCTV=http://synctv:8080
AUTH="Authorization: Bearer $SYNCTV_SERVICE_API_KEY"
```

### Rooms

Create (response: the `Room`; keep `id`):

```sh
curl -s -X POST "$SYNCTV/api/rooms" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name": "Movie night"}'
# {"id": "room_8XkqP2", "name": "Movie night", "createdBy": "usr_...", "settings": {...}, ...}
```

Optional create fields: `description`, `password`, `settings` (e.g.
`{"autoPlay": {"enabled": true}}`).

Rename (room creator / room admins):

```sh
curl -s -X PATCH "$SYNCTV/api/rooms/$ROOM/name" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name": "Friday movie night"}'
```

List the account's rooms, get one, delete one:

```sh
curl -s "$SYNCTV/api/user/rooms?pageSize=100" -H "$AUTH"
curl -s "$SYNCTV/api/rooms/$ROOM" -H "$AUTH"
curl -s -X DELETE "$SYNCTV/api/rooms/$ROOM" -H "$AUTH"       # {"success": true}
```

### Playlist (media)

Add a direct URL. `proxyMode`: 0 auto, 1 prefer proxy, 2 proxy only, 3 prefer
direct, 4 direct only. Use 2 when the link is bound to the IP that obtained it
(viewers on other networks would otherwise be refused); when omitted, the
server default `media.direct_url_default_proxy_mode` applies. `durationSeconds`
is optional; players report it once they load the video.

```sh
curl -s -X POST "$SYNCTV/api/rooms/$ROOM/media" -H "$AUTH" -H 'Content-Type: application/json' -d '{
  "name": "Part 1",
  "sourceConfig": {"directUrl": {
    "medias": [{"url": "https://cdn.example.com/part1.mp4"}],
    "proxyMode": 2
  }}
}'
# {"id": "med_3vQ9", "name": "Part 1", "roomId": "room_...", "sourceProvider": 1,
#  "sourceConfig": {"directUrl": {"medias": [...], "proxyMode": 2}}, ...}
```

Several at once: `POST /api/rooms/$ROOM/media/batch` with `{"items": [<AddMedia>, ...]}`.

List the room's root playlist (media are in `media`, in playlist order):

```sh
curl -s -X POST "$SYNCTV/api/rooms/$ROOM/media/list" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"pageSize": 100}'
# {"media": [{"id": "med_...", "name": "Part 1", ...}, ...], "fileCount": "2", ...}
```

Reorder: move media before (`beforeMediaId`) or after (`afterMediaId`) another one:

```sh
curl -s -X POST "$SYNCTV/api/rooms/$ROOM/media/move" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"mediaIds": ["med_B"], "beforeMediaId": "med_A"}'
# {"movedCount": 1, "media": [...]}
```

Rename a media you added: `PATCH /api/rooms/$ROOM/media/$MEDIA` with `{"name": "..."}`.

Replace an expired link with the same request, sending only the new URL:

```sh
curl -s -X PATCH "$SYNCTV/api/rooms/$ROOM/media/$MEDIA" -H "$AUTH" -H 'Content-Type: application/json' -d '{
  "sourceConfig": {"directUrl": {"medias": [{"url": "https://cdn.example.com/part1-new.mp4"}]}}
}'
```

The media stays the same entity: its ID, playlist place and the room's position and
play/pause state don't change, and so does its spot in the playback history. Viewers
stuck on the dead link recover on their own at the room's position.

- `proxyMode` left out (or 0): the media keeps its current mode. If it has none, the server
  default `media.direct_url_default_proxy_mode` applies.
- `durationSeconds` left out: the known length stays. Send it if the new link is a
  different video, or auto-advance will use the old length.
- Don't call `POST /playback/start` afterwards. It starts the media from 0.

Delete one media, or clear the root playlist:

```sh
curl -s -X DELETE "$SYNCTV/api/rooms/$ROOM/media/$MEDIA" -H "$AUTH"   # {"success": true}
curl -s -X DELETE "$SYNCTV/api/rooms/$ROOM/media" -H "$AUTH" -H 'Content-Type: application/json' -d '{}'
```

### Playback

Start a media (playback starts playing at 0), next / previous, stop:

```sh
curl -s -X POST "$SYNCTV/api/rooms/$ROOM/playback/start" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"mediaId": "med_A"}'
# {"roomId": "room_...", "playingMediaId": "med_A", "isPlaying": true, "position": 0.01, "speed": 1.0, ...}
curl -s -X POST "$SYNCTV/api/rooms/$ROOM/playback/next" -H "$AUTH" -H 'Content-Type: application/json' -d '{}'
curl -s -X POST "$SYNCTV/api/rooms/$ROOM/playback/previous" -H "$AUTH" -H 'Content-Type: application/json' -d '{}'
curl -s -X POST "$SYNCTV/api/rooms/$ROOM/playback/stop" -H "$AUTH" -H 'Content-Type: application/json' -d '{}'
```

Pause / play / seek (`type`: 1 play, 2 pause, 3 seek, 4 speed):

```sh
curl -s -X PATCH "$SYNCTV/api/rooms/$ROOM/playback" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"type": 2, "playing": false, "position": 300}'
```

Full playback resource (sources, `durationSeconds` once known):
`GET /api/rooms/$ROOM/playback`.

## Timeline

For the service key and root/admin users only (others get 403).

```sh
curl -s "$SYNCTV/api/service/timeline" -H "$AUTH"
curl -s "$SYNCTV/api/service/rooms/$ROOM/timeline" -H "$AUTH"
```

`/api/service/timeline` returns the active rooms: rooms with at least one
online viewer, or whose playback is running.

```json
{
  "rooms": [
    {
      "roomId": "room_8XkqP2",
      "roomName": "Friday movie night",
      "mediaId": "med_3vQ9",
      "mediaName": "Part 1",
      "playing": true,
      "speed": 1.0,
      "positionSeconds": 754.3,
      "durationSeconds": 5400.0,
      "remainingSeconds": 4645.7,
      "position": "0:12:34",
      "duration": "1:30:00",
      "onlineViewers": 3,
      "live": false,
      "serverTimeMillis": 1793755092294
    }
  ],
  "serverTimeMillis": 1793755092294
}
```

- `positionSeconds` is computed on the server clock at request time and clamped
  to the duration; `position`/`duration` are the same as `H:MM:SS`.
- `durationSeconds`, `remainingSeconds` and `duration` are `null` while the
  length is unknown (a direct URL nobody has opened yet; players report it once
  they load the video) and for live sources.
- A room with nothing selected has `null` media and position fields.
- The per-room endpoint returns one entry like the above for any room, active or not.

## Python client

```python
import os
import requests


class SyncTV:
    def __init__(self, base=os.environ.get("SYNCTV_URL", "http://synctv:8080"),
                 key=os.environ["SYNCTV_SERVICE_API_KEY"]):
        self.base = base.rstrip("/")
        self.http = requests.Session()
        self.http.headers["Authorization"] = f"Bearer {key}"

    def _call(self, method, path, body=None, **params):
        r = self.http.request(method, self.base + path, json=body, params=params or None, timeout=10)
        if not r.ok:
            raise RuntimeError(f"{method} {path}: {r.status_code} {r.text}")
        return r.json() if r.content else None

    # rooms
    def create_room(self, name):
        return self._call("POST", "/api/rooms", {"name": name})["id"]

    def rename_room(self, room, name):
        return self._call("PATCH", f"/api/rooms/{room}/name", {"name": name})

    def delete_room(self, room):
        return self._call("DELETE", f"/api/rooms/{room}")

    # playlist
    def add_url(self, room, url, name="", proxy_mode=2):
        cfg = {"directUrl": {"medias": [{"url": url}], "proxyMode": proxy_mode}}
        return self._call("POST", f"/api/rooms/{room}/media", {"name": name, "sourceConfig": cfg})["id"]

    def playlist(self, room):
        return self._call("POST", f"/api/rooms/{room}/media/list", {"pageSize": 100}).get("media", [])

    def move_before(self, room, media, before):
        return self._call("POST", f"/api/rooms/{room}/media/move",
                          {"mediaIds": [media], "beforeMediaId": before})

    def delete_media(self, room, media):
        return self._call("DELETE", f"/api/rooms/{room}/media/{media}")

    # playback
    def play(self, room, media):
        return self._call("POST", f"/api/rooms/{room}/playback/start", {"mediaId": media})

    def next(self, room):
        return self._call("POST", f"/api/rooms/{room}/playback/next", {})

    # timeline
    def timeline(self):
        return self._call("GET", "/api/service/timeline")["rooms"]

    def room_timeline(self, room):
        return self._call("GET", f"/api/service/rooms/{room}/timeline")


if __name__ == "__main__":
    tv = SyncTV()
    room = tv.create_room("Movie night")
    first = tv.add_url(room, "https://cdn.example.com/part1.mp4", "Part 1")
    tv.add_url(room, "https://cdn.example.com/part2.mp4", "Part 2")
    tv.play(room, first)
    for r in tv.timeline():
        print(r["roomName"], r["mediaName"], r["position"], "/", r["duration"] or "?")
```

## Running the Telegram bot from another app

SyncTV can leave the bot's chat to another app that uses the same token. Turn off
SyncTV's long polling with `SYNCTV_TELEGRAM_BOT_POLLING_ENABLED=false`, so the other app
can be the only consumer of updates. It can use `getUpdates` or a webhook. If two programs
call `getUpdates` with one token, Telegram answers one of them with 409.

SyncTV keeps doing these with polling off:

- Admin notifications (e.g. room admission requests) are sent with `sendMessage`. Sending
  from several processes with one token is fine.
- The Mini App opens from the chat menu button ("Open", set on Telegram's side) and from
  `https://t.me/<bot>?startapp=<payload>` links. Room invite links use this form. They
  reach the Mini App directly and need no bot update handling.

What the other app owns:

- The command list (`setMyCommands`). SyncTV no longer registers `/start` and `/invite`.
- Any replies to messages and callback queries.
- Room, playlist, playback and timeline operations, through this service API.

Avoid calling `setChatMenuButton` with a different URL. It would replace the Mini App
button.
