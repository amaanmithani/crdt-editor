/** A single contiguous replacement: delete `deleteCount` chars at `index`, then insert `insert`. */
export interface TextChange {
  index: number;
  deleteCount: number;
  insert: string;
}

/**
 * Describe the edit that turns `before` into `after` as one replacement,
 * using the longest common prefix and suffix. A textarea `input` event only
 * ever changes one contiguous range (typing, backspace, selection replacement,
 * paste, cut, drag-drop within the field, undo), so this recovers it exactly.
 * `caret` (the selection end after the edit) disambiguates repeated chars,
 * e.g. typing "a" into "aa" at the start vs the end.
 */
export function diffText(before: string, after: string, caret?: number): TextChange | null {
  if (before === after) return null;
  const maxPrefix = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < maxPrefix && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  // The inserted text ends at the caret, so the prefix can't extend past caret - inserted.
  if (caret !== undefined) {
    const inserted = Math.max(0, after.length - before.length);
    prefix = Math.max(0, Math.min(prefix, caret - inserted));
  }
  let suffix = 0;
  const maxSuffix = Math.min(before.length, after.length) - prefix;
  while (
    suffix < maxSuffix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix++;
  }
  return {
    index: prefix,
    deleteCount: before.length - prefix - suffix,
    insert: after.slice(prefix, after.length - suffix),
  };
}

/** Shift a caret/selection offset to account for a remote insert or delete at `index`. */
export function shiftOffset(
  offset: number,
  effect: { type: 'insert' | 'delete'; index: number },
): number {
  if (effect.type === 'insert') return effect.index < offset ? offset + 1 : offset;
  return effect.index < offset ? offset - 1 : offset;
}
