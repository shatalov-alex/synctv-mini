# Changelog

All notable changes to SyncTV Mini are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases are tagged
`mini-vX.Y.Z`. Each release names the upstream SyncTV version it is based on.

## [Unreleased]

## [1.0.1] - 2026-11-11

Based on SyncTV 1.0.14, plus the upstream fixes made after it, up to
[d2d4e650](https://github.com/synctv-org/synctv/commit/d2d4e650).

### Fixed

- Guests can play Bilibili videos with the room's shared Bilibili account
  ([synctv#539](https://github.com/synctv-org/synctv/pull/539)).
- When a proxied video link fails, the player gets the source's own error instead of a
  generic "service unavailable" ([synctv#541](https://github.com/synctv-org/synctv/pull/541)).
- `make release` creates the GitHub release in this repository, not in upstream SyncTV.

### Changed

- Dependencies updated from upstream ([synctv#542](https://github.com/synctv-org/synctv/pull/542)).

## [1.0.0] - 2026-11-10

Based on SyncTV 1.0.14.

### Added

- Telegram Mini App client (`lite-client/`): Telegram sign-in, a room list, and
  synchronized playback of MP4, WebM and HLS links, in about 38 KB of gzipped JavaScript.
- Invite links, redeemed from the Mini App. A link can expire after an hour or a month,
  or never. It can work for one person, a few people, or anyone who has it.
- TV mode: a TV's browser pairs with a room through a QR code and plays full screen.
  It works with the TV remote, and the phone that pairs it can act as the remote control.
- A playback gate: the room pauses while a connected device is still loading, and waits
  again after a seek until the new part has loaded.
- Subtitles, with one choice per room that the TV follows.
- A live playlist and a list of who is in the room.
- A Telegram bot with `/start` and the admin's `/invite` command, and admin notifications.
- A service API for scripts and other bots: create rooms, add videos, rename rooms, and
  see what's playing. See [docs/service-api.md](docs/service-api.md).
- New settings: `SYNCTV_TELEGRAM_*`, `SYNCTV_ROOMS_USERS_CAN_CREATE`,
  `SYNCTV_LIVESTREAM_ENABLED`, `SYNCTV_MEDIA_DIRECT_URL_DEFAULT_PROXY_MODE` and
  `SYNCTV_SERVICE_API_KEY`.
- A `grpc` cargo feature and a `SYNCTV_RUNTIME_FFMPEG` Docker build argument, so the
  slim image is about 410 MB instead of 1 GB.

### Changed

- Only admins create rooms by default.
- Guests can control playback but can't add or delete videos.
- Only the room creator and their TVs report a video's length.
- Docker Compose publishes the app on `127.0.0.1:8080` only, and no longer publishes the
  RTMP port.
- A replaced direct link keeps the room's viewing position.

### Security

- Guests and TVs stay inside the rooms they were invited or paired to.
- Someone removed from a room can't come back on an invite link sent before the removal.
- Only members who control playback can hold the room, and a hold rewinds the room by at
  most 30 seconds.
- The service API key is refused on any request that arrives through a proxy, and
  placeholder keys are rejected at startup.
- Plain accounts (guests, TVs, sign-ups) can't create rooms, so they can't make the
  server fetch addresses of their choosing.

[Unreleased]: https://github.com/shatalov-alex/synctv-mini/compare/mini-v1.0.1...HEAD
[1.0.1]: https://github.com/shatalov-alex/synctv-mini/compare/mini-v1.0.0...mini-v1.0.1
[1.0.0]: https://github.com/shatalov-alex/synctv-mini/releases/tag/mini-v1.0.0
