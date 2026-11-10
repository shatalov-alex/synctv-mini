import { render } from 'preact';
import './styles.css';
import { matchRoute } from './router';
import { loadMiniApp } from './links';

const root = document.getElementById('app') as HTMLElement;

// The TV page never loads the Telegram bridge or the Mini App code.
if (matchRoute(location.pathname, location.search).name === 'tv') {
  Promise.all([import('./pages/Tv'), loadMiniApp()]).then(([{ Tv }]) => render(<Tv />, root));
} else {
  Promise.all([import('./telegram'), import('./app'), loadMiniApp()]).then(([telegram, app]) =>
    telegram.initTelegram().then((tg) => render(<app.App tg={tg} />, root)),
  );
}
