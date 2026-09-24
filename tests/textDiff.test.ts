import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { diffText, shiftOffset } from '../src/client/textDiff.js';

const apply = (s: string, c: { index: number; deleteCount: number; insert: string }): string =>
  s.slice(0, c.index) + c.insert + s.slice(c.index + c.deleteCount);

describe('diffText', () => {
  it('recovers typing, backspace, selection replacement and paste', () => {
    expect(diffText('abc', 'abc')).toBeNull();
    expect(diffText('ac', 'abc', 2)).toEqual({ index: 1, deleteCount: 0, insert: 'b' });
    expect(diffText('abc', 'ac', 1)).toEqual({ index: 1, deleteCount: 1, insert: '' });
    expect(diffText('hello world', 'hello there', 11)).toEqual({
      index: 6,
      deleteCount: 5,
      insert: 'there',
    });
    expect(diffText('abcabc', 'axbc', 2)).toEqual({ index: 1, deleteCount: 3, insert: 'x' });
  });

  it('uses the caret to place ambiguous inserts', () => {
    expect(diffText('aa', 'aaa', 1)).toEqual({ index: 0, deleteCount: 0, insert: 'a' });
    expect(diffText('aa', 'aaa', 3)).toEqual({ index: 2, deleteCount: 0, insert: 'a' });
    expect(diffText('aa', 'aaa')).toEqual({ index: 2, deleteCount: 0, insert: 'a' });
  });

  it('always produces a change that reproduces the new text', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom('a', 'b', 'c'), maxLength: 12 }),
        fc.nat(),
        fc.nat(),
        fc.string({ unit: fc.constantFrom('a', 'b', 'c'), maxLength: 4 }),
        (before, i, n, ins) => {
          const index = i % (before.length + 1);
          const del = n % (before.length - index + 1);
          const after = before.slice(0, index) + ins + before.slice(index + del);
          const change = diffText(before, after, index + ins.length);
          if (change === null) expect(after).toBe(before);
          else expect(apply(before, change)).toBe(after);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('shiftOffset', () => {
  it('moves carets past remote edits before them only', () => {
    expect(shiftOffset(5, { type: 'insert', index: 2 })).toBe(6);
    expect(shiftOffset(5, { type: 'insert', index: 5 })).toBe(5);
    expect(shiftOffset(5, { type: 'delete', index: 2 })).toBe(4);
    expect(shiftOffset(5, { type: 'delete', index: 5 })).toBe(5);
  });
});
