// Tiny history router for the four SPA routes. The server falls back to
// index.html for extension-less HTML navigations, so deep links work.
import { useEffect, useState } from 'preact/hooks';

export type Route =
  | { name: 'home' }
  | { name: 'room'; roomId: string }
  | { name: 'tv' }
  | { name: 'pair'; code: string }
  | { name: 'notFound' };

export function matchRoute(pathname: string, search: string): Route {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return { name: 'home' };
  if (path === '/tv') return { name: 'tv' };
  if (path === '/pair') {
    const m = search.match(/[?&]code=([^&#]*)/);
    return { name: 'pair', code: m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '' };
  }
  const room = path.match(/^\/room\/([^/]+)$/);
  if (room) return { name: 'room', roomId: decodeURIComponent(room[1]) };
  return { name: 'notFound' };
}

export function roomPath(roomId: string): string {
  return `/room/${encodeURIComponent(roomId)}`;
}

const listeners: Array<() => void> = [];

export function navigate(path: string, replace = false): void {
  // Keep the hash: telegram-web-app.js reads its launch params from it.
  const url = path + location.hash;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  for (const l of listeners.slice()) l();
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => matchRoute(location.pathname, location.search));
  useEffect(() => {
    const update = () => setRoute(matchRoute(location.pathname, location.search));
    listeners.push(update);
    window.addEventListener('popstate', update);
    return () => {
      listeners.splice(listeners.indexOf(update), 1);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return route;
}
