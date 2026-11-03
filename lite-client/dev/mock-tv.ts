// Dev-only in-memory mock of the TV pairing API (POST /api/tv/pairings*).
//
// Enabled by `VITE_MOCK_TV=1 pnpm dev`. The claim handler hands the claiming
// phone's own bearer token to the TV, which is enough to exercise the UI flow
// against a real dev server for everything else. Never shipped in a build.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Plugin } from 'vite';

interface Pairing {
  code: string;
  secret: string;
  expiresAt: number;
  claimed?: { roomId: string; accessToken: string };
  delivered?: boolean;
}

const TTL_MS = 5 * 60 * 1000;

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export function mockTvPairing(): Plugin {
  const pairings = new Map<string, Pairing>();
  return {
    name: 'synctv-lite-mock-tv',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '';
        if (req.method !== 'POST' || !url.startsWith('/api/tv/pairings')) return next();
        const body = await readJson(req);
        const now = Date.now();
        if (url === '/api/tv/pairings') {
          const code = String(Math.floor(100000 + Math.random() * 900000));
          const secret = randomBytes(24).toString('base64url');
          pairings.set(secret, { code, secret, expiresAt: now + TTL_MS });
          return send(res, 200, {
            code,
            pairingSecret: secret,
            expiresAt: String(Math.floor((now + TTL_MS) / 1000)),
            pollIntervalMs: 2000,
          });
        }
        if (url === '/api/tv/pairings/poll') {
          const pairing = pairings.get(String(body.pairingSecret ?? ''));
          if (!pairing || pairing.expiresAt < now || pairing.delivered) {
            return send(res, 200, { status: 'EXPIRED' });
          }
          if (!pairing.claimed) return send(res, 200, { status: 'PENDING' });
          pairing.delivered = true;
          return send(res, 200, {
            status: 'CLAIMED',
            roomId: pairing.claimed.roomId,
            login: { user: { id: 'mock', username: 'tv' }, accessToken: pairing.claimed.accessToken, refreshToken: '' },
          });
        }
        if (url === '/api/tv/pairings/claim') {
          const auth = String(req.headers.authorization ?? '');
          if (!auth.startsWith('Bearer ')) return send(res, 401, { code: 16, message: 'unauthenticated' });
          for (const pairing of pairings.values()) {
            if (pairing.code === body.code && pairing.expiresAt > now && !pairing.claimed) {
              pairing.claimed = { roomId: String(body.roomId ?? ''), accessToken: auth.slice(7) };
              return send(res, 200, {});
            }
          }
          return send(res, 404, { code: 5, message: 'pairing code not found or expired' });
        }
        next();
      });
    },
  };
}
