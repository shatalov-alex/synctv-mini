// Refreshes the vendored copy of Telegram's Mini App bridge script.
//
// The SynCTV server sends `script-src 'self'` in its default CSP, so the
// script cannot be loaded from telegram.org; we serve a same-origin copy from
// public/telegram-web-app.js instead. Run `pnpm vendor:telegram` to update it.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://telegram.org/js/telegram-web-app.js';
const target = fileURLToPath(new URL('../public/telegram-web-app.js', import.meta.url));

const response = await fetch(SOURCE);
if (!response.ok) {
  throw new Error(`GET ${SOURCE} failed: ${response.status}`);
}
const body = await response.text();
if (!body.includes('WebApp')) {
  throw new Error('Unexpected telegram-web-app.js contents');
}
await writeFile(target, `// Vendored from ${SOURCE} on ${new Date().toISOString().slice(0, 10)}\n${body}`);
console.log(`wrote ${target} (${body.length} bytes)`);
