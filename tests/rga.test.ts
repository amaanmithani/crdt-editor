import { describe, expect, it } from 'vitest';
import { Rga } from '../src/crdt/rga.js';
import { compareIds, idKey, isValidId } from '../src/crdt/ids.js';
import { isOp, type Op } from '../src/crdt/ops.js';
import { decodeSnapshot, encodeSnapshot, SnapshotError } from '../src/crdt/snapshot.js';

describe('Rga local editing', () => {
  it('inserts and deletes like a string', () => {
    const doc = new Rga('a');
    doc.insert(0, 'hello');
    doc.insert(5, ' world');
    doc.insert(0, '>');
    expect(doc.toString()).toBe('>hello world');
    doc.delete(0);
    doc.delete(5, 6);
    expect(doc.toString()).toBe('hello');
    expect(doc.length).toBe(5);
    expect(doc.stats()).toMatchObject({ items: 12, tombstones: 7, pending: 0 });
  });

  it('returns one op per character with chained origins', () => {
    const doc = new Rga('a');
    const ops = doc.insert(0, 'abc');
    expect(ops.map((o) => o.id)).toEqual([
      [1, 'a'],
      [2, 'a'],
      [3, 'a'],
    ]);
    expect(ops.map((o) => o.l)).toEqual([null, [1, 'a'], [2, 'a']]);
    expect(doc.lamport).toBe(3);
    expect(doc.delete(1)).toEqual([{ t: 'd', id: [2, 'a'] }]);
  });

  it('rejects out-of-range edits', () => {
    const doc = new Rga('a');
    doc.insert(0, 'ab');
    expect(() => doc.insert(3, 'x')).toThrow(RangeError);
    expect(() => doc.insert(-1, 'x')).toThrow(RangeError);
    expect(() => doc.delete(1, 2)).toThrow(RangeError);
    expect(() => doc.delete(0, 1.5)).toThrow(RangeError);
    expect(() => new Rga('')).toThrow();
    expect(doc.delete(2, 0)).toEqual([]);
  });

  it('handles documents spanning many blocks', () => {
    const doc = new Rga('a');
    let model = '';
    let seed = 42;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 5000; i++) {
      if (model.length > 0 && rand(3) === 0) {
        const p = rand(model.length);
        doc.delete(p);
        model = model.slice(0, p) + model.slice(p + 1);
      } else {
        const p = rand(model.length + 1);
        const ch = String.fromCharCode(97 + rand(26));
        doc.insert(p, ch);
        model = model.slice(0, p) + ch + model.slice(p);
      }
    }
    expect(doc.toString()).toBe(model);
    expect(doc.stats().blocks).toBeGreaterThan(1);
    const copy = Rga.fromSnapshot('b', doc.snapshot());
    expect(copy.toString()).toBe(model);
  });
  it('pastes long text across block splits', () => {
    const doc = new Rga('a');
    const other = new Rga('b');
    const big = 'x'.repeat(300) + 'y'.repeat(300);
    other.applyRemoteAll(doc.insert(0, big));
    const paste = Array.from({ length: 1000 }, (_, i) => String.fromCharCode(65 + (i % 26))).join(
      '',
    );
    other.applyRemoteAll(doc.insert(300, paste));
    const expected = 'x'.repeat(300) + paste + 'y'.repeat(300);
    expect(doc.toString()).toBe(expected);
    expect(other.toString()).toBe(expected);
  });
});

describe('Rga remote ops', () => {
  it('orders concurrent inserts at the same spot by id (worked README example)', () => {
    const a = new Rga('alice');
    const b = new Rga('bob');
    b.applyRemoteAll(a.insert(0, 'ac'));
    // Both insert between "a" and "c" with the same Lamport counter 3.
    const fromA = a.insert(1, 'X');
    const fromB = b.insert(1, 'Y');
    a.applyRemoteAll(fromB);
    b.applyRemoteAll(fromA);
    // Tie on counter: "bob" > "alice", so bob's Y sits closer to the origin "a".
    expect(a.toString()).toBe('aYXc');
    expect(b.toString()).toBe('aYXc');
  });

  it('is idempotent and reports effects with indices', () => {
    const a = new Rga('a');
    const b = new Rga('b');
    const ops = a.insert(0, 'hi');
    expect(b.applyRemoteAll(ops)).toEqual([
      { type: 'insert', index: 0, value: 'h' },
      { type: 'insert', index: 1, value: 'i' },
    ]);
    expect(b.applyRemoteAll(ops)).toEqual([]);
    const del = a.delete(0);
    expect(b.applyRemoteAll(del)).toEqual([{ type: 'delete', index: 0 }]);
    expect(b.applyRemoteAll(del)).toEqual([]);
    expect(b.toString()).toBe('i');
    expect(b.has([1, 'a'])).toBe(true);
    expect(b.has([9, 'a'])).toBe(false);
  });

  it('buffers ops whose dependencies have not arrived and releases them in order', () => {
    const a = new Rga('a');
    const ops: Op[] = [...a.insert(0, 'abc'), ...a.delete(1)];
    const b = new Rga('b');
    // Deliver fully reversed, with a duplicate of a buffered op.
    expect(b.applyRemote(ops[3]!)).toEqual([]);
    expect(b.applyRemote(ops[2]!)).toEqual([]);
    expect(b.applyRemote(ops[2]!)).toEqual([]);
    expect(b.applyRemote(ops[1]!)).toEqual([]);
    expect(b.pendingCount).toBe(3);
    const effects = b.applyRemote(ops[0]!);
    expect(b.pendingCount).toBe(0);
    expect(effects).toEqual([
      { type: 'insert', index: 0, value: 'a' },
      { type: 'insert', index: 1, value: 'b' },
      // the buffered delete of "b" was queued before "c", so it replays first
      { type: 'delete', index: 1 },
      { type: 'insert', index: 1, value: 'c' },
    ]);
    expect(b.toString()).toBe('ac');
  });

  it('advances its Lamport clock past remote counters', () => {
    const a = new Rga('a');
    a.applyRemote({ t: 'i', id: [41, 'z'], l: null, v: 'x' });
    expect(a.insert(1, 'y')[0]!.id).toEqual([42, 'a']);
  });
});

describe('snapshots', () => {
  it('round-trips state including tombstones and compact origins', () => {
    const a = new Rga('a');
    a.insert(0, 'hello');
    a.insert(0, 'X'); // origin = document start, not the previous element
    a.insert(3, 'Y'); // X h e Y l l o
    a.delete(1, 2);
    const snap = a.snapshot();
    expect(snap.text.length).toBe(7);
    expect(snap.items.length).toBe(28);
    expect(snap.replicas).toEqual(['a']);
    const b = Rga.fromSnapshot('b', snap);
    expect(b.toString()).toBe(a.toString());
    expect(b.snapshot()).toEqual(snap);
    expect(b.merge(snap)).toEqual([]);
  });

  it('encodes explicit origins when the left neighbour is not the previous item', () => {
    const a = new Rga('a');
    a.insert(0, 'ab');
    const b = new Rga('b');
    b.merge(a.snapshot());
    b.insert(1, 'x'); // origin 'a', between a and b
    a.merge(b.snapshot());
    a.insert(3, 'z'); // origin 'b' (after x)
    const decoded = decodeSnapshot(a.snapshot());
    expect(decoded.map((d) => d.value).join('')).toBe('axbz');
    expect(decoded[2]!.left).toEqual([1, 'a']); // 'b' after 'x' still points to 'a'
  });

  it('merging an empty snapshot is a no-op', () => {
    const empty = encodeSnapshot([]);
    expect(empty).toEqual({ v: 1, replicas: [], items: [], text: '', deleted: [] });
    expect(new Rga('a').merge(empty)).toEqual([]);
  });

  it.each([
    ['null', null],
    ['wrong version', { v: 2 }],
    ['missing fields', { v: 1, replicas: [] }],
    ['length mismatch', { v: 1, replicas: ['a'], items: [1, 0], text: 'x', deleted: [1] }],
    ['bad replica table', { v: 1, replicas: [''], items: [1, 0, 0, -1], text: 'x', deleted: [1] }],
    ['bad run', { v: 1, replicas: ['a'], items: [1, 0, 0, -1], text: 'x', deleted: [-1] }],
    ['run mismatch', { v: 1, replicas: ['a'], items: [1, 0, 0, -1], text: 'x', deleted: [2] }],
    ['bad replica idx', { v: 1, replicas: ['a'], items: [1, 5, 0, -1], text: 'x', deleted: [1] }],
    ['bad counter', { v: 1, replicas: ['a'], items: [0, 0, 0, -1], text: 'x', deleted: [1] }],
    ['previous on first', { v: 1, replicas: ['a'], items: [1, 0, 0, -2], text: 'x', deleted: [1] }],
    ['bad left counter', { v: 1, replicas: ['a'], items: [1, 0, -3, 0], text: 'x', deleted: [1] }],
  ])('rejects malformed snapshot: %s', (_name, snap) => {
    expect(() => decodeSnapshot(snap)).toThrow(SnapshotError);
  });
});

describe('ids and op validation', () => {
  it('orders ids by counter then replica', () => {
    expect(compareIds([2, 'a'], [1, 'z'])).toBeGreaterThan(0);
    expect(compareIds([1, 'b'], [1, 'a'])).toBeGreaterThan(0);
    expect(compareIds([1, 'a'], [1, 'b'])).toBeLessThan(0);
    expect(compareIds([1, 'a'], [1, 'a'])).toBe(0);
    expect(idKey([3, 'r'])).toBe('3@r');
  });

  it('validates untrusted ops', () => {
    expect(isValidId([1, 'a'])).toBe(true);
    expect(isValidId([0, 'a'])).toBe(false);
    expect(isValidId([1, ''])).toBe(false);
    expect(isOp({ t: 'i', id: [1, 'a'], l: null, v: 'x' })).toBe(true);
    expect(isOp({ t: 'i', id: [1, 'a'], l: [1, 'b'], v: 'xy' })).toBe(false);
    expect(isOp({ t: 'd', id: [1, 'a'] })).toBe(true);
    expect(isOp({ t: 'x' })).toBe(false);
    expect(isOp(null)).toBe(false);
  });
});
