# Contributing to SyncTV Mini

Thanks for helping. Bug reports, fixes and small focused features are welcome.

SyncTV Mini aims to stay small: a private setup for an owner, a few guests and a TV. A
feature that only makes sense for a large public server is likely a better fit for
[SyncTV](https://github.com/synctv-org/synctv) itself. If you're unsure, open an issue and
ask before writing the code.

## Where a change belongs

- **Telegram Mini App, TV page, invites, the service API, or this fork's settings:** here.
- **The sync engine, media providers, or other server code this fork hasn't changed:**
  upstream SyncTV, so every user gets it. This fork merges upstream releases.

## Setting up

You need Rust (the version is pinned in `rust-toolchain.toml`), `protoc`, Docker, and
Node.js 20.19+ with pnpm. Linux builds also need `nasm`, `libclang` and `lld`.

```sh
docker compose -f docker-compose.dev.yml up -d postgres redis
SQLX_OFFLINE=true cargo check --workspace --all-targets

cd lite-client
pnpm install
pnpm dev
```

## Checks

Run these before you open a pull request. CI runs them too.

Server:

```sh
cargo fmt --all
SQLX_OFFLINE=true cargo clippy --workspace --all-targets -- -D warnings
SQLX_OFFLINE=true cargo test --workspace
SQLX_OFFLINE=true cargo test --workspace -- --ignored   # needs Docker
```

Client:

```sh
cd lite-client
pnpm typecheck && pnpm test && pnpm build
```

`pnpm build` prints the bundle size. Keep it small: the client loads inside Telegram, often
on a phone.

### Database queries

The server checks SQL at compile time against the metadata in `.sqlx/`. If you add or
change a query or a migration, regenerate it against a migrated database:

```sh
DATABASE_URL=postgresql://synctv:synctv@127.0.0.1:5432/synctv sqlx migrate run
DATABASE_URL=postgresql://synctv:synctv@127.0.0.1:5432/synctv \
  cargo sqlx prepare --workspace -- --all-targets
```

Commit the changed `.sqlx/` files with your change.

## Pull requests

- One change per pull request, with a test where it makes sense.
- Commit subjects use the form `Area: what changed`, for example
  `Invites: links that never expire`.
- Explain what the change does for the user, and how you checked it.
- Don't commit secrets, `.env.*` files (other than the examples), or your own domain and
  bot names.

## Security problems

Don't open a public issue. See [SECURITY.md](SECURITY.md).

## License

Contributions are released under the [MIT License](LICENSE), like the rest of the project.
