import { isValidId, type Id } from './ids.js';

/** Insert one UTF-16 code unit `v` with id `id` immediately after element `l` (null = document start). */
export interface InsertOp {
  readonly t: 'i';
  readonly id: Id;
  readonly l: Id | null;
  readonly v: string;
}

/** Tombstone the element with id `id`. */
export interface DeleteOp {
  readonly t: 'd';
  readonly id: Id;
}

export type Op = InsertOp | DeleteOp;

/** A visible change produced by applying an op, expressed as a string index. */
export type Effect =
  | { readonly type: 'insert'; readonly index: number; readonly value: string }
  | { readonly type: 'delete'; readonly index: number };

export function isOp(value: unknown): value is Op {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  if (o.t === 'd') return isValidId(o.id);
  if (o.t === 'i') {
    return (
      isValidId(o.id) &&
      (o.l === null || isValidId(o.l)) &&
      typeof o.v === 'string' &&
      o.v.length === 1
    );
  }
  return false;
}
