import { isOp, type Op } from '../crdt/ops.js';
import type { Snapshot } from '../crdt/snapshot.js';

export interface Peer {
  readonly replica: string;
  readonly name: string;
}

export type ClientMessage =
  { type: 'join'; room: string; replica: string; name: string } | { type: 'ops'; ops: Op[] };

export type ServerMessage =
  | { type: 'welcome'; room: string; snapshot: Snapshot; peers: Peer[] }
  | { type: 'ops'; from: string; ops: Op[] }
  | { type: 'peers'; peers: Peer[] }
  | { type: 'error'; message: string };

export const MAX_OPS_PER_MESSAGE = 50_000;
const NAME_RE = /^[\w.-]{1,64}$/;

export function isValidName(value: unknown): value is string {
  return typeof value === 'string' && NAME_RE.test(value);
}

/** Parse and validate an untrusted client message. Returns null if invalid. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type === 'join') {
    if (!isValidName(m.room) || !isValidName(m.replica)) return null;
    const name = typeof m.name === 'string' ? m.name.slice(0, 40) : m.replica;
    return { type: 'join', room: m.room, replica: m.replica, name };
  }
  if (m.type === 'ops') {
    if (!Array.isArray(m.ops) || m.ops.length > MAX_OPS_PER_MESSAGE) return null;
    if (!m.ops.every(isOp)) return null;
    return { type: 'ops', ops: m.ops };
  }
  return null;
}
