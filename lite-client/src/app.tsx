import { useEffect, useState } from 'preact/hooks';
import { api, bootstrap, type BootResult } from './auth';
import { navigate, roomPath, useRoute } from './router';
import type { TgWebApp } from './telegram';
import { Home } from './pages/Home';
import { Pair } from './pages/Pair';
import { Room } from './pages/Room';

export function App({ tg }: { tg: TgWebApp | null }) {
  const route = useRoute();
  const [boot, setBoot] = useState<BootResult | null>(null);

  useEffect(() => {
    api.setOnSignedOut(() => setBoot((b) => (b ? { ...b, me: null, error: 'Session expired. Reopen the app.' } : b)));
    bootstrap(tg).then((result) => {
      setBoot(result);
      // Deep-link from the launch: invite → its room; pair-<code> → /pair.
      if (result.me && result.roomId) navigate(roomPath(result.roomId), true);
      else if (result.me && result.intent.kind === 'pair') {
        navigate(`/pair?code=${encodeURIComponent(result.intent.code)}`, true);
      }
    });
  }, []);

  if (!boot) {
    return (
      <main class="page center">
        <p class="muted">Signing in…</p>
      </main>
    );
  }
  if (!boot.me) {
    return (
      <main class="page center">
        <h1>SyncTV</h1>
        <p class="error">{boot.error || 'Not signed in.'}</p>
      </main>
    );
  }
  const banner = boot.error ? <p class="error page-banner">{boot.error}</p> : null;
  switch (route.name) {
    case 'room':
      return (
        <>
          {banner}
          <Room key={route.roomId} roomId={route.roomId} me={boot.me} />
        </>
      );
    case 'pair':
      return <Pair code={route.code} me={boot.me} />;
    case 'home':
      return (
        <>
          {banner}
          <Home me={boot.me} />
        </>
      );
    default:
      return (
        <main class="page center">
          <p>Page not found.</p>
          <button onClick={() => navigate('/')}>Home</button>
        </main>
      );
  }
}
