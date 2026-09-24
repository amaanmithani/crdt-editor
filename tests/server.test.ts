import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startSyncServer, type SyncServer } from '../src/server/syncServer.js';
import { SyncClient, type SocketLike } from '../src/client/syncClient.js';
import { parseClientMessage } from '../src/sync/protocol.js';

const createSocket = (url: string): SocketLike => new WebSocket(url) as unknown as SocketLike;

async function waitFor(cond: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

let dir: string;
let server: SyncServer;
const clients: SyncClient[] = [];

function client(replica: string, room = 'doc', reconnectDelayMs = 0): SyncClient {
  const c = new SyncClient({
    url: `ws://127.0.0.1:${server.port}`,
    room,
    replica,
    createSocket,
    reconnectDelayMs,
  });
  clients.push(c);
  return c;
}

const converged = (cs: SyncClient[], room = 'doc'): boolean =>
  cs.every((c) => c.doc.toString() === server.roomText(room) && c.doc.pendingCount === 0);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crdt-editor-'));
  server = await startSyncServer({
    port: 0,
    persistPath: join(dir, 'rooms.json'),
    persistIntervalMs: 20,
  });
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

describe('sync server', () => {
  it('converges three clients after concurrent edits', async () => {
    const [a, b, c] = [client('a'), client('b'), client('c')];
    for (const x of [a, b, c]) x.connect();
    await waitFor(
      () => [a, b, c].every((x) => x.status === 'online' && x.peers.length === 3),
      'online',
    );

    a.insert(0, 'hello');
    b.insert(0, 'world');
    c.insert(0, '!!');
    await waitFor(() => server.roomText('doc').length === 12 && converged([a, b, c]), 'converge');

    // Concurrent edits interleaved with deletes, all at once.
    a.insert(2, 'AAA');
    b.delete(0, 3);
    c.insert(c.doc.length, 'end');
    await waitFor(() => converged([a, b, c]) && a.doc.length === 12 + 3 - 3 + 3, 'converge 2');
    expect(new Set([a, b, c].map((x) => x.doc.toString())).size).toBe(1);
  });

  it('a new client joins mid-session via snapshot', async () => {
    const a = client('a');
    a.connect();
    await waitFor(() => a.status === 'online', 'a online');
    a.insert(0, 'existing text');
    a.delete(0, 9);
    await waitFor(() => server.roomText('doc') === 'text', 'server has text');
    const late = client('late');
    const changes: number[] = [];
    late.on('change', (effects) => changes.push(effects.length));
    late.connect();
    await waitFor(() => late.doc.toString() === 'text', 'late caught up');
    expect(changes.length).toBeGreaterThan(0);
  });

  it('offline client buffers edits, then merges both ways on reconnect', async () => {
    const [a, b] = [client('a'), client('b')];
    const statuses: string[] = [];
    b.on('status', (s) => statuses.push(s));
    a.connect();
    b.connect();
    await waitFor(() => a.status === 'online' && b.status === 'online', 'online');
    a.insert(0, 'shared base');
    await waitFor(() => b.doc.toString() === 'shared base', 'b has base');

    b.disconnect(); // network partition
    expect(b.status).toBe('offline');
    await waitFor(() => a.peers.length === 1, 'a sees b leave');
    b.insert(0, '[b offline] ');
    b.delete(b.doc.length - 5, 5); // drop " base"
    a.insert(a.doc.length, ' + a online');
    expect(b.unsynced).toBeGreaterThan(0);
    expect(server.roomText('doc')).not.toContain('[b offline]');

    b.connect();
    await waitFor(() => converged([a, b]) && b.status === 'online', 'merged');
    expect(a.doc.toString()).toBe('[b offline] shared + a online');
    expect(b.unsynced).toBe(0);
    expect(statuses).toEqual(['connecting', 'online', 'offline', 'connecting', 'online']);
  });

  it('resends ops lost in flight when the server restarts without them', async () => {
    const a = client('a', 'doc', 20);
    a.connect();
    await waitFor(() => a.status === 'online', 'online');
    a.insert(0, 'survives');
    await waitFor(() => server.roomText('doc') === 'survives', 'server has it');
    const port = server.port;
    await server.close();
    await rm(join(dir, 'rooms.json'), { force: true }); // lose persisted state
    await waitFor(() => a.status !== 'online', 'a notices');
    server = await startSyncServer({ port });
    await waitFor(() => server.roomText('doc') === 'survives', 'client re-sent state', 8000);
  });

  it('persists rooms to JSON and reloads them', async () => {
    const a = client('a', 'persisted');
    a.connect();
    await waitFor(() => a.status === 'online', 'online');
    a.insert(0, 'keep me');
    await waitFor(() => server.roomText('persisted') === 'keep me', 'applied');
    await server.persist();
    const file = JSON.parse(await readFile(join(dir, 'rooms.json'), 'utf8')) as {
      rooms: Record<string, { text: string }>;
    };
    expect(file.rooms.persisted!.text).toBe('keep me');
    a.disconnect();
    await server.close();
    server = await startSyncServer({ port: 0, persistPath: join(dir, 'rooms.json') });
    expect(server.roomText('persisted')).toBe('keep me');
    expect(server.roomNames()).toContain('persisted');
  });

  it('ignores corrupt persistence files and rooms', async () => {
    await server.close();
    const logs: string[] = [];
    const path = join(dir, 'bad.json');
    await writeFile(path, '{not json');
    server = await startSyncServer({ persistPath: path, log: (m) => logs.push(m) });
    expect(server.roomNames()).toEqual([]);
    await server.close();
    await writeFile(path, JSON.stringify({ rooms: { broken: { v: 9 } } }));
    server = await startSyncServer({ persistPath: path, log: (m) => logs.push(m) });
    expect(logs.some((l) => l.includes('unreadable'))).toBe(true);
    expect(logs.some((l) => l.includes('corrupt room broken'))).toBe(true);
  });

  it('rejects invalid messages and ops before join', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const replies: string[] = [];
    ws.on('message', (d) => replies.push(String(d)));
    await new Promise((r) => ws.once('open', r));
    ws.send('garbage');
    ws.send(JSON.stringify({ type: 'ops', ops: [] }));
    ws.send(Buffer.from([1, 2, 3]), { binary: true });
    ws.send(JSON.stringify({ type: 'join', room: 'r', replica: 'x' }));
    ws.send(JSON.stringify({ type: 'join', room: 'r', replica: 'x' }));
    ws.send(JSON.stringify({ type: 'ops', ops: [] }));
    await waitFor(() => replies.length >= 6, 'replies');
    const types = replies.map(
      (r) =>
        (JSON.parse(r) as { type: string; message?: string }).message ??
        (JSON.parse(r) as { type: string }).type,
    );
    expect(types).toEqual([
      'invalid message',
      'join first',
      'binary frames not supported',
      'welcome',
      'peers',
      'already joined',
    ]);
    ws.close();
  });

  it('serves health and static files', async () => {
    await server.close();
    const web = join(dir, 'web');
    await mkdir(web);
    await writeFile(join(web, 'index.html'), '<h1>hi</h1>');
    server = await startSyncServer({ staticDir: web });
    const base = `http://127.0.0.1:${server.port}`;
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });
    const index = await fetch(`${base}/`);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(await index.text()).toBe('<h1>hi</h1>');
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).status).not.toBe(200);
  });
});

describe('protocol parsing', () => {
  it('validates join and ops messages', () => {
    expect(parseClientMessage('{"type":"join","room":"a b","replica":"x"}')).toBeNull();
    expect(parseClientMessage('{"type":"join","room":"a","replica":"x","name":"Ann"}')).toEqual({
      type: 'join',
      room: 'a',
      replica: 'x',
      name: 'Ann',
    });
    expect(parseClientMessage('{"type":"ops","ops":[{"t":"q"}]}')).toBeNull();
    expect(parseClientMessage('[]')).toBeNull();
    expect(parseClientMessage('{"type":"nope"}')).toBeNull();
  });
});
