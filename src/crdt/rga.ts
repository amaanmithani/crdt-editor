import { compareIds, idKey, type Id, type ReplicaId } from './ids.js';
import type { DeleteOp, Effect, InsertOp, Op } from './ops.js';
import { decodeSnapshot, encodeSnapshot, type Snapshot, type SnapshotItem } from './snapshot.js';

/** One element of the sequence. Deleted elements stay in place as tombstones. */
interface Item {
  readonly id: Id;
  readonly key: string;
  readonly value: string;
  /** Left origin this element was inserted after (null = document start). */
  readonly left: Id | null;
  deleted: boolean;
  block: Block;
}

/**
 * The sequence is stored as an ordered list of blocks so that inserting into
 * the middle costs O(B) array shifting instead of O(n), and so that visible
 * index lookups can skip whole blocks by their cached visible count.
 */
interface Block {
  items: Item[];
  visible: number;
}

const MAX_BLOCK = 512;

interface Position {
  bi: number;
  ii: number;
}

/**
 * RGA (Replicated Growable Array) sequence CRDT for plain text.
 *
 * - Every character has a unique id `[lamport, replica]`.
 * - An insert names its left neighbour at creation time (its *origin*).
 * - Concurrent inserts after the same origin are ordered by id, larger first.
 * - Deletes only set a tombstone flag, so ids stay resolvable forever.
 *
 * `applyRemote` is idempotent and tolerates any delivery order: an op whose
 * dependency (left origin for inserts, target for deletes) has not arrived yet
 * is buffered and replayed as soon as the dependency is integrated.
 */
export class Rga {
  readonly replica: ReplicaId;
  private clock = 0;
  private blocks: Block[] = [{ items: [], visible: 0 }];
  private readonly index = new Map<string, Item>();
  private readonly pending = new Map<string, Op[]>();
  private readonly pendingSeen = new Set<string>();
  private visibleLength = 0;

  constructor(replica: ReplicaId) {
    if (replica.length === 0) throw new Error('replica id must be non-empty');
    this.replica = replica;
  }

  static fromSnapshot(replica: ReplicaId, snapshot: Snapshot): Rga {
    const doc = new Rga(replica);
    doc.merge(snapshot);
    return doc;
  }

  /** Number of visible characters. */
  get length(): number {
    return this.visibleLength;
  }

  /** Number of ops waiting for a dependency that has not been delivered yet. */
  get pendingCount(): number {
    return this.pendingSeen.size;
  }

  /** Current Lamport clock (highest counter seen or generated). */
  get lamport(): number {
    return this.clock;
  }

  stats(): { items: number; tombstones: number; blocks: number; pending: number } {
    return {
      items: this.index.size,
      tombstones: this.index.size - this.visibleLength,
      blocks: this.blocks.length,
      pending: this.pendingCount,
    };
  }

  toString(): string {
    let out = '';
    for (const block of this.blocks) {
      if (block.visible === 0) continue;
      for (const item of block.items) if (!item.deleted) out += item.value;
    }
    return out;
  }

  has(id: Id): boolean {
    return this.index.has(idKey(id));
  }

  // ---------------------------------------------------------------- local ops

  /** Insert `text` so that its first character ends up at visible `index`. */
  insert(index: number, text: string): InsertOp[] {
    this.checkIndex(index, this.visibleLength);
    const ops: InsertOp[] = [];
    let left: Id | null = index === 0 ? null : this.itemAtVisible(index - 1).id;
    for (let i = 0; i < text.length; i++) {
      const op: InsertOp = { t: 'i', id: [++this.clock, this.replica], l: left, v: text[i]! };
      this.integrateInsert(op);
      ops.push(op);
      left = op.id;
    }
    return ops;
  }

  /** Delete `count` visible characters starting at visible `index`. */
  delete(index: number, count = 1): DeleteOp[] {
    this.checkIndex(index, this.visibleLength);
    if (!Number.isInteger(count) || count < 0 || index + count > this.visibleLength) {
      throw new RangeError(`cannot delete ${count} chars at ${index} (length ${this.length})`);
    }
    const ops: DeleteOp[] = [];
    for (let k = 0; k < count; k++) {
      const item = this.itemAtVisible(index);
      this.tombstone(item);
      ops.push({ t: 'd', id: item.id });
    }
    return ops;
  }

  // --------------------------------------------------------------- remote ops

  /**
   * Apply an op from another replica. Returns the visible effects in the
   * order they happened (buffered ops released by this one included).
   * Applying the same op twice is a no-op.
   */
  applyRemote(op: Op): Effect[] {
    const effects: Effect[] = [];
    const queue: Op[] = [op];
    while (queue.length > 0) {
      const next = queue.shift()!;
      const released = this.applyOne(next, effects);
      if (released) queue.push(...released);
    }
    return effects;
  }

  applyRemoteAll(ops: Iterable<Op>): Effect[] {
    const effects: Effect[] = [];
    for (const op of ops) effects.push(...this.applyRemote(op));
    return effects;
  }

  // ---------------------------------------------------------------- snapshots

  /** Full state, including tombstones, in document order. */
  snapshot(): Snapshot {
    const items: SnapshotItem[] = [];
    for (const block of this.blocks) {
      for (const item of block.items) {
        items.push({ id: item.id, left: item.left, value: item.value, deleted: item.deleted });
      }
    }
    return encodeSnapshot(items);
  }

  /**
   * Merge a full-state snapshot from any replica. Equivalent to applying every
   * insert (and delete) that the snapshot's replica had seen; ops already known
   * locally are skipped, so merging is idempotent and commutative.
   */
  merge(snapshot: Snapshot): Effect[] {
    const effects: Effect[] = [];
    for (const item of decodeSnapshot(snapshot)) {
      effects.push(...this.applyRemote({ t: 'i', id: item.id, l: item.left, v: item.value }));
      if (item.deleted) effects.push(...this.applyRemote({ t: 'd', id: item.id }));
    }
    return effects;
  }

  // ---------------------------------------------------------------- internals

  private applyOne(op: Op, effects: Effect[]): Op[] | undefined {
    const key = idKey(op.id);
    if (op.t === 'i') {
      if (this.index.has(key)) return undefined; // duplicate delivery
      if (op.l !== null && !this.index.has(idKey(op.l))) {
        this.buffer(idKey(op.l), op, `i:${key}`);
        return undefined;
      }
      if (op.id[0] > this.clock) this.clock = op.id[0];
      const at = this.integrateInsert(op);
      effects.push({ type: 'insert', index: at, value: op.v });
      return this.release(key);
    }
    const item = this.index.get(key);
    if (!item) {
      this.buffer(key, op, `d:${key}`);
      return undefined;
    }
    if (item.deleted) return undefined;
    const at = this.visibleIndexOf(item);
    this.tombstone(item);
    effects.push({ type: 'delete', index: at });
    return undefined;
  }

  private buffer(dependency: string, op: Op, opKey: string): void {
    if (this.pendingSeen.has(opKey)) return;
    this.pendingSeen.add(opKey);
    const list = this.pending.get(dependency);
    if (list) list.push(op);
    else this.pending.set(dependency, [op]);
  }

  private release(dependency: string): Op[] | undefined {
    const waiting = this.pending.get(dependency);
    if (!waiting) return undefined;
    this.pending.delete(dependency);
    for (const op of waiting) this.pendingSeen.delete(`${op.t}:${idKey(op.id)}`);
    return waiting;
  }

  /** Place a new element per the RGA rule and return its visible index. */
  private integrateInsert(op: InsertOp): number {
    let pos: Position;
    if (op.l === null) {
      pos = { bi: 0, ii: 0 };
    } else {
      pos = this.locate(this.index.get(idKey(op.l))!);
      pos.ii += 1;
    }
    // Skip over elements that sort before us: siblings with larger ids and,
    // transitively, their descendants (which always carry even larger ids).
    for (;;) {
      let block = this.blocks[pos.bi]!;
      if (pos.ii >= block.items.length) {
        if (pos.bi === this.blocks.length - 1) break;
        pos = { bi: pos.bi + 1, ii: 0 };
        block = this.blocks[pos.bi]!;
      }
      if (compareIds(block.items[pos.ii]!.id, op.id) > 0) pos.ii++;
      else break;
    }
    const at = this.visibleOffset(pos);
    const block = this.blocks[pos.bi]!;
    const key = idKey(op.id);
    const item: Item = {
      id: op.id,
      key,
      value: op.v,
      left: op.l,
      deleted: false,
      block,
    };
    block.items.splice(pos.ii, 0, item);
    block.visible++;
    this.visibleLength++;
    this.index.set(key, item);
    if (block.items.length > MAX_BLOCK) this.split(pos.bi);
    return at;
  }

  private tombstone(item: Item): void {
    item.deleted = true;
    item.block.visible--;
    this.visibleLength--;
  }

  private split(bi: number): void {
    const block = this.blocks[bi]!;
    const half = block.items.length >> 1;
    const moved = block.items.splice(half);
    const fresh: Block = { items: moved, visible: 0 };
    for (const item of moved) {
      item.block = fresh;
      if (!item.deleted) fresh.visible++;
    }
    block.visible -= fresh.visible;
    this.blocks.splice(bi + 1, 0, fresh);
  }

  private locate(item: Item): Position {
    const bi = this.blocks.indexOf(item.block);
    return { bi, ii: item.block.items.indexOf(item) };
  }

  private visibleOffset(pos: Position): number {
    let offset = 0;
    for (let b = 0; b < pos.bi; b++) offset += this.blocks[b]!.visible;
    const items = this.blocks[pos.bi]!.items;
    for (let i = 0; i < pos.ii; i++) if (!items[i]!.deleted) offset++;
    return offset;
  }

  private visibleIndexOf(item: Item): number {
    return this.visibleOffset(this.locate(item));
  }

  private itemAtVisible(index: number): Item {
    let remaining = index;
    for (const block of this.blocks) {
      if (remaining >= block.visible) {
        remaining -= block.visible;
        continue;
      }
      for (const item of block.items) {
        if (item.deleted) continue;
        if (remaining === 0) return item;
        remaining--;
      }
    }
    /* c8 ignore next */
    throw new RangeError(`visible index ${index} out of range`);
  }

  private checkIndex(index: number, max: number): void {
    if (!Number.isInteger(index) || index < 0 || index > max) {
      throw new RangeError(`index ${index} out of range [0, ${max}]`);
    }
  }
}
