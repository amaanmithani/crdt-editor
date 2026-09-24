import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, rename, writeFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { Rga } from '../crdt/rga.js';
import type { Snapshot } from '../crdt/snapshot.js';
import { parseClientMessage, type Peer, type ServerMessage } from '../sync/protocol.js';

export interface SyncServerOptions {
  /** Port to listen on; 0 picks an ephemeral port. */
  port?: number;
  host?: string;
  /** JSON file to persist room snapshots to. Persistence is off when omitted. */
  persistPath?: string;
  persistIntervalMs?: number;
  /** Directory with the built web client to serve over HTTP (optional). */
  staticDir?: string;
  log?: (msg: string) => void;
}

interface Room {
  readonly name: string;
  readonly doc: Rga;
  readonly clients: Set<Conn>;
  dirty: boolean;
}

interface Conn {
  readonly socket: WebSocket;
  room?: Room;
  peer?: Peer;
}

export interface SyncServer {
  readonly port: number;
  /** Current text of a room ('' if the room does not exist). */
  roomText(name: string): string;
  roomNames(): string[];
  /** Write dirty rooms to the persistence file now. */
  persist(): Promise<void>;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

/** The server keeps its own replica per room; its replica id never authors ops. */
const SERVER_REPLICA = '~server';

export async function startSyncServer(options: SyncServerOptions = {}): Promise<SyncServer> {
  const log = options.log ?? (() => {});
  const rooms = new Map<string, Room>();

  const getRoom = (name: string): Room => {
    let room = rooms.get(name);
    if (!room) {
      room = { name, doc: new Rga(SERVER_REPLICA), clients: new Set(), dirty: false };
      rooms.set(name, room);
    }
    return room;
  };

  if (options.persistPath) {
    for (const [name, snapshot] of Object.entries(await loadRooms(options.persistPath, log))) {
      try {
        getRoom(name).doc.merge(snapshot);
      } catch (err) {
        log(`skipping corrupt room ${name}: ${String(err)}`);
      }
    }
  }

  const http = createServer((req, res) => {
    void serveHttp(req, res, options.staticDir);
  });
  const wss = new WebSocketServer({ server: http, maxPayload: 8 * 1024 * 1024 });

  const send = (conn: Conn, msg: ServerMessage): void => {
    if (conn.socket.readyState === WebSocket.OPEN) conn.socket.send(JSON.stringify(msg));
  };
  const peersOf = (room: Room): Peer[] =>
    [...room.clients].flatMap((c) => (c.peer ? [c.peer] : []));
  const broadcastPeers = (room: Room): void => {
    const peers = peersOf(room);
    for (const c of room.clients) send(c, { type: 'peers', peers });
  };

  wss.on('connection', (socket) => {
    const conn: Conn = { socket };
    socket.on('message', (data, isBinary) => {
      if (isBinary) return send(conn, { type: 'error', message: 'binary frames not supported' });
      const raw = Array.isArray(data)
        ? Buffer.concat(data).toString()
        : Buffer.from(data as ArrayBuffer).toString();
      const msg = parseClientMessage(raw);
      if (!msg) return send(conn, { type: 'error', message: 'invalid message' });

      if (msg.type === 'join') {
        if (conn.room) return send(conn, { type: 'error', message: 'already joined' });
        const room = getRoom(msg.room);
        conn.room = room;
        conn.peer = { replica: msg.replica, name: msg.name };
        room.clients.add(conn);
        send(conn, {
          type: 'welcome',
          room: room.name,
          snapshot: room.doc.snapshot(),
          peers: peersOf(room),
        });
        broadcastPeers(room);
        log(`join ${msg.replica} -> ${room.name} (${room.clients.size} clients)`);
        return;
      }

      const room = conn.room;
      if (!room || !conn.peer) return send(conn, { type: 'error', message: 'join first' });
      if (msg.ops.length === 0) return;
      for (const op of msg.ops) room.doc.applyRemote(op);
      room.dirty = true;
      const out: ServerMessage = { type: 'ops', from: conn.peer.replica, ops: msg.ops };
      for (const c of room.clients) if (c !== conn) send(c, out);
    });
    socket.on('close', () => {
      const room = conn.room;
      if (!room) return;
      room.clients.delete(conn);
      broadcastPeers(room);
      log(`leave ${conn.peer?.replica ?? '?'} <- ${room.name}`);
    });
    socket.on('error', (err) => log(`socket error: ${err.message}`));
  });

  // Writes are serialised so an interval write and an explicit/close write
  // never race on the temp file, and `persist()` resolves after any in-flight write.
  let persisting: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    persisting = persisting.then(writeRooms, writeRooms);
    return persisting;
  };
  const writeRooms = async (): Promise<void> => {
    if (!options.persistPath) return;
    const dirty = [...rooms.values()].some((r) => r.dirty);
    if (!dirty) return;
    const data: Record<string, Snapshot> = {};
    for (const room of rooms.values()) {
      data[room.name] = room.doc.snapshot();
      room.dirty = false;
    }
    const tmp = `${options.persistPath}.tmp`;
    await writeFile(tmp, JSON.stringify({ v: 1, rooms: data }));
    await rename(tmp, options.persistPath);
  };

  const timer = options.persistPath
    ? setInterval(() => {
        persist().catch((err: unknown) => log(`persist failed: ${String(err)}`));
      }, options.persistIntervalMs ?? 2000)
    : undefined;
  timer?.unref();

  await new Promise<void>((ok, fail) => {
    http.once('error', fail);
    http.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => ok());
  });
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    roomText: (name) => rooms.get(name)?.doc.toString() ?? '',
    roomNames: () => [...rooms.keys()],
    persist,
    close: async () => {
      if (timer) clearInterval(timer);
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((ok) => wss.close(() => ok()));
      await new Promise<void>((ok) => http.close(() => ok()));
      await persist();
    },
  };
}

async function loadRooms(
  path: string,
  log: (msg: string) => void,
): Promise<Record<string, Snapshot>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as { rooms?: Record<string, Snapshot> };
    return parsed.rooms ?? {};
  } catch (err) {
    log(`ignoring unreadable persistence file ${path}: ${String(err)}`);
    return {};
  }
}

async function serveHttp(
  req: IncomingMessage,
  res: ServerResponse,
  staticDir: string | undefined,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    return;
  }
  if (!staticDir) {
    res.writeHead(404).end('not found');
    return;
  }
  const root = resolve(staticDir);
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = normalize(join(root, rel));
  if (!file.startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}
