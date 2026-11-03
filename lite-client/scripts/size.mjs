// Prints raw and gzipped sizes of the built JS/CSS so bundle growth is visible.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist', import.meta.url));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const rows = walk(dist)
  .filter((file) => /\.(js|css|html)$/.test(file))
  .map((file) => {
    const bytes = readFileSync(file);
    return { file: relative(dist, file), raw: bytes.length, gz: gzipSync(bytes, { level: 9 }).length };
  })
  .sort((a, b) => b.gz - a.gz);

let appGz = 0;
for (const row of rows) {
  const vendor = /hls|telegram-web-app/.test(row.file);
  if (!vendor && row.file.endsWith('.js')) appGz += row.gz;
  console.log(
    `${row.file.padEnd(48)} ${(row.raw / 1024).toFixed(1).padStart(8)} KB  ${(row.gz / 1024).toFixed(1).padStart(7)} KB gz${vendor ? '  (lazy vendor)' : ''}`,
  );
}
console.log(`app JS total (excl. hls.js, telegram-web-app.js): ${(appGz / 1024).toFixed(1)} KB gz`);
