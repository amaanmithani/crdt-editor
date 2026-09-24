/**
 * Benchmarks for the RGA implementation. Run with `npm run bench`.
 * Writes results/bench.json. Uses a seeded PRNG so runs are comparable.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Rga } from '../src/crdt/rga.js';
import type { Op } from '../src/crdt/ops.js';

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

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz ';

/** Apply `n` random single-char edits (70% inserts) at random positions; return the ops. */
function randomEdits(doc: Rga, n: number, rand: () => number): Op[] {
  const ops: Op[] = [];
  for (let i = 0; i < n; i++) {
    if (doc.length > 0 && rand() < 0.3) {
      ops.push(...doc.delete(Math.floor(rand() * doc.length)));
    } else {
      const ch = ALPHABET[Math.floor(rand() * ALPHABET.length)]!;
      ops.push(...doc.insert(Math.floor(rand() * (doc.length + 1)), ch));
    }
  }
  return ops;
}

function time<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
}

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
const round = (x: number, d = 1): number => Math.round(x * 10 ** d) / 10 ** d;

// Warm up the JIT so the first measured scenario is not penalised.
randomEdits(new Rga('warm'), 20_000, mulberry32(1));

// 1. Local throughput: 100k random inserts/deletes on one replica.
const N = 100_000;
const local = new Rga('local');
const { result: localOps, ms: localMs } = time(() => randomEdits(local, N, mulberry32(42)));

// 2. Remote throughput: replay those ops in order on a fresh replica.
const remote = new Rga('remote');
const { ms: remoteMs } = time(() => {
  for (const op of localOps) remote.applyRemote(op);
});
if (remote.toString() !== local.toString()) throw new Error('remote replay diverged');

// 3. Merge two replicas that diverged by 10k ops each from a shared 10k-char base.
const DIVERGE = 10_000;
const base = new Rga('base');
const baseOps = randomEdits(base, 14_000, mulberry32(7));
const a = Rga.fromSnapshot('alice', base.snapshot());
const b = Rga.fromSnapshot('bob', base.snapshot());
const aOps = randomEdits(a, DIVERGE, mulberry32(100));
const bOps = randomEdits(b, DIVERGE, mulberry32(200));
const aSnap = a.snapshot();
const bSnap = b.snapshot();
const { ms: opMergeMs } = time(() => {
  a.applyRemoteAll(bOps);
  b.applyRemoteAll(aOps);
});
if (a.toString() !== b.toString()) throw new Error('op merge diverged');
const a2 = Rga.fromSnapshot('alice', aSnap);
const { ms: snapMergeMs } = time(() => a2.merge(bSnap));
if (a2.toString() !== a.toString()) throw new Error('snapshot merge diverged');

// 4. Snapshot size vs text length.
const typed = new Rga('typist');
for (let i = 0; i < 50_000; i++) typed.insert(typed.length, ALPHABET[i % ALPHABET.length]!);
const sizeOf = (doc: Rga) => {
  const snap = doc.snapshot();
  const stats = doc.stats();
  const snapshotBytes = bytes(snap);
  return {
    textLength: doc.length,
    elementsIncludingTombstones: stats.items,
    tombstones: stats.tombstones,
    snapshotBytes,
    bytesPerVisibleChar: round(snapshotBytes / Math.max(1, doc.length), 2),
    bytesPerElement: round(snapshotBytes / stats.items, 2),
  };
};

const results = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    cpu: cpus()[0]?.model ?? 'unknown',
    platform: `${process.platform}-${process.arch}`,
    loadAverage1m: round(loadavg()[0]!, 2),
    note: 'single run, wall-clock; numbers vary with machine load',
  },
  localEdits: {
    description: '100k random single-char edits (70% insert / 30% delete) at random positions',
    ops: N,
    ms: round(localMs),
    opsPerSec: Math.round(N / (localMs / 1000)),
    finalTextLength: local.length,
    elements: local.stats().items,
  },
  remoteReplay: {
    description: 'the same 100k ops applied via applyRemote on a fresh replica',
    ops: localOps.length,
    ms: round(remoteMs),
    opsPerSec: Math.round(localOps.length / (remoteMs / 1000)),
  },
  divergedMerge: {
    description:
      'two replicas share a base (14k edits), then each makes 10k random edits offline; merge both ways',
    baseOps: baseOps.length,
    opsPerSide: DIVERGE,
    opBasedMergeMs: round(opMergeMs),
    snapshotMergeMs: round(snapMergeMs),
    mergedTextLength: a.length,
  },
  snapshotSize: {
    sequentialTyping50k: sizeOf(typed),
    randomEdits100k: sizeOf(local),
  },
};

mkdirSync('results', { recursive: true });
writeFileSync('results/bench.json', `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
