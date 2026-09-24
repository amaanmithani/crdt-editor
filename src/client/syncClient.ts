import { idKey } from '../crdt/ids.js';
import { Rga } from '../crdt/rga.js';
import { decodeSnapshot, type Snapshot } from '../crdt/snapshot.js';
import type { Effect, Op } from '../crdt/ops.js';
import type { Peer, ServerMessage } from '../sync/protocol.js';

/** The subset of the WebSocket API used here; satisfied by browsers and the `ws` package. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type Status = 'offline' | 'connecting' | 'online';

export interface SyncClientOptions {
  url: string;
  room: string;
  replica: string;
  name?: string;
  createSocket: (url: string) => SocketLike;
  /** Delay before automatically reconnecting after an unexpected drop. 0 disables. */
  reconnectDelayMs?: number;
}

interface Listeners {
  change: (effects: Effect[]) => void;
  peers: (peers: Peer[]) => void;
  status: (status: Status) => void;
}

const OPEN = 1;

/**
 * Connects an `Rga` replica to the relay server.
 *
 * Local edits are sent immediately while online and queued in an outbox while
 * offline. On (re)connect the server replies with its room snapshot; the
 * client merges it (receiving whatever it missed) and then sends every local
 * op the server's snapshot lacks — which is exactly the outbox, plus anything
 * lost in flight when the previous connection dropped.
 */
export class SyncClient {
  readonly doc: Rga;
  private readonly opts: SyncClientOptions;
  private socket: SocketLike | null = null;
  private outbox: Op[] = [];
  private wantOnline = false;
  private currentStatus: Status = 'offline';
  private currentPeers: Peer[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners: { [K in keyof Listeners]: Set<Listeners[K]> } = {
    change: new Set(),
    peers: new Set(),
    status: new Set(),
  };

  constructor(options: SyncClientOptions) {
    this.opts = options;
    this.doc = new Rga(options.replica);
  }

  get status(): Status {
    return this.currentStatus;
  }

  get peers(): Peer[] {
    return this.currentPeers;
  }

  /** Local ops not yet handed to an open connection. */
  get unsynced(): number {
    return this.outbox.length;
  }

  on<K extends keyof Listeners>(event: K, fn: Listeners[K]): () => void {
    this.listeners[event].add(fn);
    return () => this.listeners[event].delete(fn);
  }

  connect(): void {
    this.wantOnline = true;
    if (this.socket) return;
    this.setStatus('connecting');
    const socket = this.opts.createSocket(this.opts.url);
    this.socket = socket;
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: 'join',
          room: this.opts.room,
          replica: this.opts.replica,
          name: this.opts.name ?? this.opts.replica,
        }),
      );
    };
    socket.onmessage = (ev) => this.handleMessage(String(ev.data));
    socket.onclose = () => this.handleClose(socket);
    socket.onerror = () => {
      /* followed by close */
    };
  }

  /** Go offline (e.g. to simulate a network partition). Local editing continues. */
  disconnect(): void {
    this.wantOnline = false;
    clearTimeout(this.retryTimer);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.currentPeers = [];
    this.emit('peers', []);
    this.setStatus('offline');
  }

  insert(index: number, text: string): void {
    this.queue(this.doc.insert(index, text));
  }

  delete(index: number, count = 1): void {
    this.queue(this.doc.delete(index, count));
  }

  private queue(ops: Op[]): void {
    if (ops.length === 0) return;
    if (this.currentStatus === 'online' && this.socket?.readyState === OPEN) {
      this.socket.send(JSON.stringify({ type: 'ops', ops }));
    } else {
      this.outbox.push(...ops);
    }
  }

  private handleMessage(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'welcome': {
        const effects = this.doc.merge(msg.snapshot);
        const missing = opsMissingFrom(this.doc, msg.snapshot);
        this.outbox = [];
        if (missing.length > 0) this.socket?.send(JSON.stringify({ type: 'ops', ops: missing }));
        this.currentPeers = msg.peers;
        this.setStatus('online');
        this.emit('peers', msg.peers);
        if (effects.length > 0) this.emit('change', effects);
        break;
      }
      case 'ops': {
        const effects = this.doc.applyRemoteAll(msg.ops);
        if (effects.length > 0) this.emit('change', effects);
        break;
      }
      case 'peers':
        this.currentPeers = msg.peers;
        this.emit('peers', msg.peers);
        break;
      case 'error':
        break;
    }
  }

  private handleClose(socket: SocketLike): void {
    if (this.socket !== socket) return; // an intentional disconnect already handled it
    this.socket = null;
    this.currentPeers = [];
    this.emit('peers', []);
    this.setStatus('offline');
    const delay = this.opts.reconnectDelayMs ?? 1000;
    if (this.wantOnline && delay > 0) {
      this.retryTimer = setTimeout(() => {
        if (this.wantOnline) this.connect();
      }, delay);
    }
  }

  private setStatus(status: Status): void {
    if (status === this.currentStatus) return;
    this.currentStatus = status;
    this.emit('status', status);
  }

  private emit<K extends keyof Listeners>(event: K, ...args: Parameters<Listeners[K]>): void {
    for (const fn of this.listeners[event])
      (fn as (...a: Parameters<Listeners[K]>) => void)(...args);
  }
}

/**
 * Ops that `doc` has but `snapshot` doesn't: inserts of unknown elements (in
 * document order, so origins precede dependants) and deletes of elements the
 * snapshot still shows as live.
 */
export function opsMissingFrom(doc: Rga, snapshot: Snapshot): Op[] {
  const theirs = new Map<string, boolean>();
  for (const item of decodeSnapshot(snapshot)) theirs.set(idKey(item.id), item.deleted);
  const ops: Op[] = [];
  const deletes: Op[] = [];
  for (const item of decodeSnapshot(doc.snapshot())) {
    const known = theirs.get(idKey(item.id));
    if (known === undefined) ops.push({ t: 'i', id: item.id, l: item.left, v: item.value });
    if (item.deleted && known !== true) deletes.push({ t: 'd', id: item.id });
  }
  return ops.concat(deletes);
}
