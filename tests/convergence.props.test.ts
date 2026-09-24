import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Rga } from '../src/crdt/rga.js';
import { compareIds } from '../src/crdt/ids.js';
import type { Op } from '../src/crdt/ops.js';

/** `npm run test:props` sets FC_RUNS=2000; the default suite uses a smaller count. */
const RUNS = Number(process.env.FC_RUNS ?? 150);
const PARAMS = { numRuns: RUNS };

// ---------------------------------------------------------------- simulation

type Action =
  | { kind: 'insert'; replica: number; pos: number; len: number }
  | { kind: 'delete'; replica: number; pos: number; len: number }
  | { kind: 'deliver'; replica: number; pick: number; duplicate: boolean }
  | { kind: 'snapshotMerge'; from: number; to: number };

const unit = fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true });

const actionArb = (replicas: number): fc.Arbitrary<Action> => {
  const r = fc.nat({ max: replicas - 1 });
  return fc.oneof(
    {
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constant('insert' as const),
        replica: r,
        pos: unit,
        len: fc.integer({ min: 1, max: 3 }),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant('delete' as const),
        replica: r,
        pos: unit,
        len: fc.integer({ min: 1, max: 2 }),
      }),
    },
    {
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constant('deliver' as const),
        replica: r,
        pick: unit,
        duplicate: fc.boolean(),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({ kind: fc.constant('snapshotMerge' as const), from: r, to: r }),
    },
  );
};

const sessionArb = fc.integer({ min: 2, max: 5 }).chain((replicas) =>
  fc.record({
    replicas: fc.constant(replicas),
    actions: fc.array(actionArb(replicas), { minLength: 1, maxLength: 80 }),
    seed: fc.integer(),
  }),
);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SessionResult {
  docs: Rga[];
  /** Every string any replica showed after one of its own actions. */
  observed: string[];
  inserted: Set<string>;
  deleted: Set<string>;
}

/**
 * Run a session: replicas edit concurrently; every op is broadcast to every
 * other replica's inbox; inboxes are drained in random order with duplicates
 * and arbitrary delay. Each inserted character is unique so identity can be
 * checked by value. At the end all inboxes are flushed in a shuffled order
 * with every message delivered twice.
 */
function runSession(replicas: number, actions: Action[], seed: number): SessionResult {
  const docs = Array.from({ length: replicas }, (_, i) => new Rga(`r${i}`));
  const inboxes: Op[][] = docs.map(() => []);
  const observed: string[] = [];
  const inserted = new Set<string>();
  const deleted = new Set<string>();
  let nextChar = 0x4e00; // CJK block: plenty of distinct single-code-unit chars

  const broadcast = (from: number, ops: Op[]): void => {
    inboxes.forEach((inbox, i) => {
      if (i !== from) inbox.push(...ops);
    });
  };

  for (const action of actions) {
    if (action.kind === 'insert') {
      const doc = docs[action.replica]!;
      const pos = Math.floor(action.pos * (doc.length + 1));
      let text = '';
      for (let k = 0; k < action.len; k++) text += String.fromCharCode(nextChar++);
      for (const ch of text) inserted.add(ch);
      broadcast(action.replica, doc.insert(pos, text));
      observed.push(doc.toString());
    } else if (action.kind === 'delete') {
      const doc = docs[action.replica]!;
      if (doc.length === 0) continue;
      const pos = Math.floor(action.pos * doc.length);
      const len = Math.min(action.len, doc.length - pos);
      const before = doc.toString();
      const ops = doc.delete(pos, len);
      for (const ch of before.slice(pos, pos + len)) deleted.add(ch);
      broadcast(action.replica, ops);
      observed.push(doc.toString());
    } else if (action.kind === 'deliver') {
      const inbox = inboxes[action.replica]!;
      if (inbox.length === 0) continue;
      const idx = Math.floor(action.pick * inbox.length);
      const op = inbox[idx]!;
      if (!action.duplicate) inbox.splice(idx, 1);
      docs[action.replica]!.applyRemote(op);
    } else {
      docs[action.to]!.merge(docs[action.from]!.snapshot());
    }
  }

  const rand = mulberry32(seed);
  docs.forEach((doc, i) => {
    const pending = [...inboxes[i]!, ...inboxes[i]!];
    for (let k = pending.length - 1; k > 0; k--) {
      const j = Math.floor(rand() * (k + 1));
      [pending[k], pending[j]] = [pending[j]!, pending[k]!];
    }
    for (const op of pending) doc.applyRemote(op);
  });
  return { docs, observed, inserted, deleted };
}

// --------------------------------------------------------------- properties

describe(`convergence properties (${RUNS} runs each)`, () => {
  it('all replicas converge under random order, duplication and delay', () => {
    fc.assert(
      fc.property(sessionArb, ({ replicas, actions, seed }) => {
        const { docs } = runSession(replicas, actions, seed);
        const expected = docs[0]!.toString();
        for (const doc of docs) {
          expect(doc.toString()).toBe(expected);
          expect(doc.pendingCount).toBe(0);
        }
      }),
      PARAMS,
    );
  });

  it('final text = inserted chars minus deleted chars (a delete never removes a different char)', () => {
    fc.assert(
      fc.property(sessionArb, ({ replicas, actions, seed }) => {
        const { docs, inserted, deleted } = runSession(replicas, actions, seed);
        const expected = [...inserted].filter((c) => !deleted.has(c)).sort();
        expect([...docs[0]!.toString()].sort()).toEqual(expected);
      }),
      PARAMS,
    );
  });

  it('relative order of surviving chars never changes after any replica has seen it', () => {
    fc.assert(
      fc.property(sessionArb, ({ replicas, actions, seed }) => {
        const { docs, observed } = runSession(replicas, actions, seed);
        const rank = new Map([...docs[0]!.toString()].map((c, i) => [c, i]));
        for (const view of observed) {
          const ranks = [...view].flatMap((c) => (rank.has(c) ? [rank.get(c)!] : []));
          for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeGreaterThan(ranks[i - 1]!);
        }
      }),
      PARAMS,
    );
  });

  it('state-based merge: snapshots merged in any order converge and are idempotent', () => {
    fc.assert(
      fc.property(sessionArb, fc.integer(), ({ replicas, actions }, seed) => {
        // Run without the final flush by passing only edits: isolate replicas entirely.
        const edits = actions.filter((a) => a.kind === 'insert' || a.kind === 'delete');
        const { docs } = runSession(replicas, edits, seed);
        const snaps = docs.map((d) => d.snapshot());
        const rand = mulberry32(seed);
        const joiner = new Rga('joiner');
        const order = snaps.map((_, i) => i).sort(() => rand() - 0.5);
        for (const i of order) joiner.merge(snaps[i]!);
        joiner.merge(snaps[order[0]!]!); // idempotent
        for (const doc of docs) for (const s of snaps) doc.merge(s);
        for (const doc of docs) expect(doc.toString()).toBe(joiner.toString());
      }),
      PARAMS,
    );
  });

  it('concurrent inserts at the same position are ordered deterministically by id', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),
        fc.string({ unit: fc.constantFrom('a', 'b', 'c'), maxLength: 6 }),
        unit,
        fc.integer(),
        (replicas, base, posFrac, seed) => {
          const origin = new Rga('base');
          const baseOps = origin.insert(0, base);
          const docs = Array.from({ length: replicas }, (_, i) => new Rga(`p${i}`));
          for (const d of docs) d.applyRemoteAll(baseOps);
          const pos = Math.floor(posFrac * (base.length + 1));
          const ops = docs.map((d, i) => d.insert(pos, String.fromCharCode(0x41 + i))[0]!);
          const rand = mulberry32(seed);
          for (const d of docs) {
            const shuffled = [...ops].sort(() => rand() - 0.5);
            d.applyRemoteAll(shuffled);
          }
          const expectedMiddle = [...ops]
            .sort((a, b) => compareIds(b.id, a.id))
            .map((o) => (o.t === 'i' ? o.v : ''))
            .join('');
          const expected = base.slice(0, pos) + expectedMiddle + base.slice(pos);
          for (const d of docs) expect(d.toString()).toBe(expected);
        },
      ),
      PARAMS,
    );
  });
});
