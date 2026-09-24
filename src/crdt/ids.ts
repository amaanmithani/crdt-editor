/**
 * Element identifiers: a Lamport counter plus the id of the replica that
 * created the element. Together they are globally unique and totally ordered.
 */
export type ReplicaId = string;

/** `[counter, replica]` — tuple form keeps the wire encoding small. */
export type Id = readonly [counter: number, replica: ReplicaId];

export function idKey(id: Id): string {
  return `${id[0]}@${id[1]}`;
}

/**
 * Total order over ids. Positive when `a` sorts *before* `b` among siblings,
 * i.e. `a` has the higher counter, ties broken by the higher replica id.
 * RGA places newer (larger) siblings closer to their left origin.
 */
export function compareIds(a: Id, b: Id): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] === b[1]) return 0;
  return a[1] > b[1] ? 1 : -1;
}

export function isValidId(value: unknown): value is Id {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isSafeInteger(value[0]) &&
    (value[0] as number) > 0 &&
    typeof value[1] === 'string' &&
    value[1].length > 0
  );
}
