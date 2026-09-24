import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSyncServer } from './syncServer.js';

const here = dirname(fileURLToPath(import.meta.url));
// Built layout: dist/server/server/main.js -> dist/web; dev layout: src/server -> dist/web.
// Only a Vite build output (it has an assets/ dir) qualifies, never the web/ sources.
const candidates = [resolve(here, '../../dist/web'), resolve(here, '../../web')];
const staticDir =
  process.env.STATIC_DIR ?? candidates.find((dir) => existsSync(join(dir, 'assets')));

const server = await startSyncServer({
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '127.0.0.1',
  persistPath: process.env.PERSIST_PATH ?? 'rooms.json',
  persistIntervalMs: 2000,
  ...(staticDir ? { staticDir } : {}),
  log: (msg) => console.log(`[sync] ${msg}`),
});
console.log(`[sync] listening on http://127.0.0.1:${server.port} (ws on the same port)`);
if (staticDir) console.log(`[sync] serving web client from ${staticDir}`);

const shutdown = (): void => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
