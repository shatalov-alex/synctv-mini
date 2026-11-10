# Security Policy

## Supported versions

Security fixes go into `main` and the latest `mini-v*` release. Older releases aren't
patched; update to the latest one.

| Version | Supported |
|---|---|
| Latest `mini-v*` release | Yes |
| `main` | Yes |
| Older releases | No |

## Reporting a vulnerability

Please don't open a public issue for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Only the maintainer sees the report.

Include:

- the release or commit you tested;
- how the server is deployed (Docker Compose, tunnel or reverse proxy, settings you changed);
- what an attacker can do, and the steps to reproduce it;
- logs, with tokens, keys, cookies and Telegram data removed.

You'll get a reply within 7 days. Once the issue is confirmed, a fix is released as soon
as practical, and you're credited in the advisory unless you'd rather not be.

## What's in scope

- Telegram sign-in, sessions and tokens.
- Invite links, room membership and roles: guests acting beyond their role, or removed
  members getting back in.
- TV pairing.
- The service API and its key.
- Media proxying and requests the server makes on a user's behalf, including SSRF.
- The default Docker Compose setup and the settings in the example files.

Problems in code this fork hasn't changed are usually upstream's too. Report those to
[SyncTV](https://github.com/synctv-org/synctv/security) as well, so every user gets the fix.

## If a secret leaked

Assume it's compromised and replace it:

- **Bot token:** revoke it in [@BotFather](https://t.me/BotFather) (`/revoke`).
- **`SYNCTV_SERVICE_API_KEY`:** generate a new one and update the scripts that use it.
- **`SYNCTV_JWT_SECRET`:** replace it; everyone signs in again.
- **Database or Redis passwords:** change them in the `.env.*` files and in the containers.

Don't change the `SYNCTV_SECURITY_*_ENCRYPTION_KEY` values unless they leaked: data
stored with them can't be read after a change.
