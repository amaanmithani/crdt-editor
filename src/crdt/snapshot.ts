import { idKey, type Id } from './ids.js';

/**
 * Compact full-state encoding.
 *
 * - `replicas`: table of replica ids; items refer to them by index.
 * - `items`: 4 numbers per element, in document order:
 *     `counter, replicaIdx, leftCounter, leftReplicaIdx`
 *   where `leftReplicaIdx` is -1 for "document start" and -2 for "the element
 *   right before me in this snapshot" (the common case when typing), in which
 *   case `leftCounter` is 0.
 * - `text`: one UTF-16 code unit per element, tombstones included.
 * - `deleted`: run-length encoded tombstone flags, alternating runs of
 *   live/deleted counts starting with live.
 */
export interface Snapshot {
  readonly v: 1;
  readonly replicas: string[];
  readonly items: number[];
  readonly text: string;
  readonly deleted: number[];
}

export interface SnapshotItem {
  readonly id: Id;
  readonly left: Id | null;
  readonly value: string;
  readonly deleted: boolean;
}

const START = -1;
const PREVIOUS = -2;

export function encodeSnapshot(items: Iterable<SnapshotItem>): Snapshot {
  const replicas: string[] = [];
  const replicaIdx = new Map<string, number>();
  const idx = (replica: string): number => {
    let i = replicaIdx.get(replica);
    if (i === undefined) {
      i = replicas.length;
      replicas.push(replica);
      replicaIdx.set(replica, i);
    }
    return i;
  };

  const nums: number[] = [];
  const deleted: number[] = [];
  let text = '';
  let prevKey: string | null = null;
  let runDeleted = false;
  let run = 0;

  for (const item of items) {
    nums.push(item.id[0], idx(item.id[1]));
    if (item.left === null) nums.push(0, START);
    else if (idKey(item.left) === prevKey) nums.push(0, PREVIOUS);
    else nums.push(item.left[0], idx(item.left[1]));
    text += item.value;
    if (item.deleted !== runDeleted) {
      deleted.push(run);
      runDeleted = item.deleted;
      run = 0;
    }
    run++;
    prevKey = idKey(item.id);
  }
  if (run > 0) deleted.push(run);
  return { v: 1, replicas, items: nums, text, deleted };
}

export class SnapshotError extends Error {}

/** Decode and validate a snapshot. Throws `SnapshotError` on malformed input. */
export function decodeSnapshot(snapshot: unknown): SnapshotItem[] {
  if (typeof snapshot !== 'object' || snapshot === null) throw new SnapshotError('not an object');
  const s = snapshot as Partial<Snapshot>;
  if (s.v !== 1) throw new SnapshotError('unsupported snapshot version');
  if (
    !Array.isArray(s.replicas) ||
    !Array.isArray(s.items) ||
    !Array.isArray(s.deleted) ||
    typeof s.text !== 'string'
  ) {
    throw new SnapshotError('missing fields');
  }
  const { replicas, items, text, deleted } = s as Snapshot;
  if (items.length !== text.length * 4) throw new SnapshotError('items/text length mismatch');
  if (!replicas.every((r) => typeof r === 'string' && r.length > 0)) {
    throw new SnapshotError('bad replica table');
  }

  const flags: boolean[] = [];
  let flag = false;
  for (const run of deleted) {
    if (!Number.isSafeInteger(run) || run < 0) throw new SnapshotError('bad deleted run');
    for (let k = 0; k < run; k++) flags.push(flag);
    flag = !flag;
  }
  if (flags.length !== text.length) throw new SnapshotError('deleted runs/text length mismatch');

  const replicaAt = (i: number): string => {
    const r = replicas[i];
    if (r === undefined) throw new SnapshotError(`bad replica index ${i}`);
    return r;
  };

  const out: SnapshotItem[] = [];
  let prev: Id | null = null;
  for (let e = 0; e < text.length; e++) {
    const [c, r, lc, lr] = items.slice(e * 4, e * 4 + 4) as [number, number, number, number];
    if (!Number.isSafeInteger(c) || c <= 0) throw new SnapshotError('bad counter');
    const id: Id = [c, replicaAt(r)];
    let left: Id | null;
    if (lr === START) left = null;
    else if (lr === PREVIOUS) {
      if (prev === null) throw new SnapshotError('"previous" origin on first element');
      left = prev;
    } else {
      if (!Number.isSafeInteger(lc) || lc <= 0) throw new SnapshotError('bad left counter');
      left = [lc, replicaAt(lr)];
    }
    out.push({ id, left, value: text[e]!, deleted: flags[e]! });
    prev = id;
  }
  return out;
}
