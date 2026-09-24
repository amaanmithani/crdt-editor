import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSyncServer } from './syncServer.js';

const here = dirname(fileURLToPath(import.meta.url));
// Built layout: dist/server/server/main.js -> dist/web; dev layout: src/server -> dist/web.
const candidates = [resolve(here, '../../web'), resolve(here, '../../dist/web')];
const staticDir = process.env.STATIC_DIR ?? candidates.find((dir) => existsSync(dir));

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
