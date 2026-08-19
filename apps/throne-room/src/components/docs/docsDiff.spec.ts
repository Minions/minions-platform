import { describe, expect, it } from 'vitest';
import { diffBlocks } from './docsDiff';

describe('diffBlocks', () => {
  it('marks a block unchanged when its text is identical in both arrays', () => {
    const result = diffBlocks(['line one', 'line two'], ['line one', 'line two']);
    expect(result).toEqual([
      { kind: 'unchanged', text: 'line one', baseIndex: 0, currentIndex: 0 },
      { kind: 'unchanged', text: 'line two', baseIndex: 1, currentIndex: 1 },
    ]);
  });

  it('marks a block added when only present in current', () => {
    const result = diffBlocks(['line one'], ['line one', 'new line']);
    expect(result).toEqual([
      { kind: 'unchanged', text: 'line one', baseIndex: 0, currentIndex: 0 },
      { kind: 'added', text: 'new line', currentIndex: 1 },
    ]);
  });

  it('marks a block removed when only present in base', () => {
    const result = diffBlocks(['line one', 'gone line'], ['line one']);
    expect(result).toEqual([
      { kind: 'unchanged', text: 'line one', baseIndex: 0, currentIndex: 0 },
      { kind: 'removed', text: 'gone line', baseIndex: 1 },
    ]);
  });

  it('produces a word-level diff for a block that changed text at the same position', () => {
    const result = diffBlocks(['the quick fox'], ['the slow fox']);
    expect(result).toEqual([
      {
        kind: 'changed',
        baseText: 'the quick fox',
        currentText: 'the slow fox',
        baseIndex: 0,
        currentIndex: 0,
        words: [
          { kind: 'unchanged', text: 'the ' },
          { kind: 'removed', text: 'quick' },
          { kind: 'added', text: 'slow' },
          { kind: 'unchanged', text: ' fox' },
        ],
      },
    ]);
  });

  it('treats two completely unrelated blocks in the same run as a separate removal and addition, not a pairing', () => {
    const base = ['keep me', 'xylophone banana quokka', 'quartz nebula wombat'];
    const current = ['keep me', 'turnip glacier penguin', 'umbrella comet falcon'];

    const result = diffBlocks(base, current);

    expect(result.map((b) => b.kind)).toEqual(['unchanged', 'added', 'added', 'removed', 'removed']);
  });

  it('pairs a single removed block with a single added block as one changed block', () => {
    const base = ['keep me', 'change me'];
    const current = ['keep me', 'change me now'];

    const result = diffBlocks(base, current);

    expect(result).toEqual([
      { kind: 'unchanged', text: 'keep me', baseIndex: 0, currentIndex: 0 },
      {
        kind: 'changed',
        baseText: 'change me',
        currentText: 'change me now',
        baseIndex: 1,
        currentIndex: 1,
        words: [
          { kind: 'unchanged', text: 'change me ' },
          { kind: 'added', text: 'now' },
        ],
      },
    ]);
  });

  it('matches an edited block to its true counterpart instead of collapsing with an adjacent deletion (bug: editing the title right before a deleted block)', () => {
    // Regression for: editing a title and deleting the paragraph right after
    // it should NOT read as "delete everything, then create a new title" —
    // the title should match itself (word-level change) and the deleted
    // paragraph should show up as its own separate removal.
    const base = ['# CodeWarp Suite', 'This paragraph gets deleted entirely.', 'Get started'];
    const current = ['# CodeWarp Suite (renamed)', 'Get started'];

    const result = diffBlocks(base, current);

    expect(result).toEqual([
      {
        kind: 'changed',
        baseText: '# CodeWarp Suite',
        currentText: '# CodeWarp Suite (renamed)',
        baseIndex: 0,
        currentIndex: 0,
        words: [
          { kind: 'unchanged', text: '# CodeWarp Suite ' },
          { kind: 'added', text: '(renamed)' },
        ],
      },
      { kind: 'removed', text: 'This paragraph gets deleted entirely.', baseIndex: 1 },
      { kind: 'unchanged', text: 'Get started', baseIndex: 2, currentIndex: 1 },
    ]);
  });

  it('resolves several separate nearby edits independently instead of merging into one big delete+create hunk', () => {
    // Regression for: a handful of scattered edits (not all adjacent) should
    // each match their own counterpart, not collapse into one giant hunk.
    const base = [
      'Install Node.js.',
      'Install pnpm and nx.',
      'Install dependencies.',
      'Build The Smith.',
    ];
    const current = [
      'Install Node.js version 20.',
      'Install pnpm and nx globally.',
      'Install dependencies.',
      'Build and package The Smith.',
    ];

    const result = diffBlocks(base, current);

    expect(result.map((b) => b.kind)).toEqual(['changed', 'changed', 'unchanged', 'changed']);
    expect((result[0] as { baseText: string }).baseText).toBe('Install Node.js.');
    expect((result[1] as { baseText: string }).baseText).toBe('Install pnpm and nx.');
    expect((result[3] as { baseText: string }).baseText).toBe('Build The Smith.');
  });

  it('tags each entry with baseIndex/currentIndex into the original arrays, for mapping back to real nodes on revert', () => {
    const base = ['keep', 'gone', 'edited'];
    const current = ['keep', 'edited now', 'new'];

    const result = diffBlocks(base, current);

    expect(result).toEqual([
      { kind: 'unchanged', text: 'keep', baseIndex: 0, currentIndex: 0 },
      { kind: 'removed', text: 'gone', baseIndex: 1 },
      {
        kind: 'changed',
        baseText: 'edited',
        currentText: 'edited now',
        baseIndex: 2,
        currentIndex: 1,
        words: [
          { kind: 'unchanged', text: 'edited ' },
          { kind: 'added', text: 'now' },
        ],
      },
      { kind: 'added', text: 'new', currentIndex: 2 },
    ]);
  });

  it('returns an empty array for two empty block lists', () => {
    expect(diffBlocks([], [])).toEqual([]);
  });
});
