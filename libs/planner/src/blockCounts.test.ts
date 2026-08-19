import { describe, it, expect } from 'vitest';
import { computeBlockCounts, computeChainLengths } from './blockCounts.js';
import { asNodeId } from '@minions/planner-types';
import type { PlanItem } from '@minions/planner-types';

function item(overrides: Partial<Omit<PlanItem, 'id' | 'requires'>> & { id: string; requires?: string[] }): PlanItem {
  return {
    title: overrides.id,
    type: 'task',
    parent: null,
    children: [],
    criteria: [],
    approved: false,
    started: false,
    onPath: false,
    questions: [],
    ...overrides,
    id: asNodeId(overrides.id),
    requires: (overrides.requires ?? []).map(asNodeId),
  };
}

describe('computeBlockCounts', () => {
  it('gives zero counts when nothing requires anything', () => {
    const items = { a: item({ id: 'a' }), b: item({ id: 'b' }) };
    const counts = computeBlockCounts(items);
    expect(counts['a']).toEqual({ directBlocks: 0, indirectBlocks: 0 });
    expect(counts['b']).toEqual({ directBlocks: 0, indirectBlocks: 0 });
  });

  it('counts a single direct requirer', () => {
    const items = {
      a: item({ id: 'a' }),
      b: item({ id: 'b', requires: ['a'] }),
    };
    const counts = computeBlockCounts(items);
    expect(counts['a']).toEqual({ directBlocks: 1, indirectBlocks: 0 });
    expect(counts['b']).toEqual({ directBlocks: 0, indirectBlocks: 0 });
  });

  it('counts a transitive chain as indirect on the root', () => {
    // c requires b requires a: a is directly blocked by b, transitively by c.
    const items = {
      a: item({ id: 'a' }),
      b: item({ id: 'b', requires: ['a'] }),
      c: item({ id: 'c', requires: ['b'] }),
    };
    const counts = computeBlockCounts(items);
    expect(counts['a']).toEqual({ directBlocks: 1, indirectBlocks: 1 });
    expect(counts['b']).toEqual({ directBlocks: 1, indirectBlocks: 0 });
    expect(counts['c']).toEqual({ directBlocks: 0, indirectBlocks: 0 });
  });

  it('dedupes an item reachable via multiple paths to a: it counts once, as direct', () => {
    // b requires a, c requires a, d requires b and c -> d reaches a via two paths.
    const items = {
      a: item({ id: 'a' }),
      b: item({ id: 'b', requires: ['a'] }),
      c: item({ id: 'c', requires: ['a'] }),
      d: item({ id: 'd', requires: ['b', 'c'] }),
    };
    const counts = computeBlockCounts(items);
    // a is directly blocked by b and c (2), and indirectly by d (counted once, not twice).
    expect(counts['a']).toEqual({ directBlocks: 2, indirectBlocks: 1 });
  });

  it('never double counts an item as both direct and indirect', () => {
    // c requires a directly AND requires b which also requires a.
    const items = {
      a: item({ id: 'a' }),
      b: item({ id: 'b', requires: ['a'] }),
      c: item({ id: 'c', requires: ['a', 'b'] }),
    };
    const counts = computeBlockCounts(items);
    // a's blockers: b (direct), c (direct, even though also reachable via b).
    expect(counts['a']).toEqual({ directBlocks: 2, indirectBlocks: 0 });
  });

  it('does not infinite-loop or inflate counts on a requires cycle', () => {
    // a requires b, b requires a (should not happen structurally, but must be safe).
    const items = {
      a: item({ id: 'a', requires: ['b'] }),
      b: item({ id: 'b', requires: ['a'] }),
    };
    const counts = computeBlockCounts(items);
    expect(counts['a']).toEqual({ directBlocks: 1, indirectBlocks: 0 });
    expect(counts['b']).toEqual({ directBlocks: 1, indirectBlocks: 0 });
  });

  it('scales to a realistic large graph within a tight time budget', () => {
    // Simulate a large multi-repo-scale requires graph: 5000 items, each
    // requiring up to 3 earlier items (guarantees a DAG, no cycles), plus a
    // long dependency chain so some nodes have deep transitive block sets.
    const N = 5000;
    const items: Record<string, PlanItem> = {};
    for (let i = 0; i < N; i++) {
      const id = `item-${i}`;
      const requires: string[] = [];
      if (i > 0) requires.push(`item-${i - 1}`); // long chain
      for (let k = 0; k < 2 && i > 0; k++) {
        const dep = Math.floor(Math.random() * i);
        requires.push(`item-${dep}`);
      }
      items[id] = item({ id, requires });
    }

    const start = performance.now();
    const counts = computeBlockCounts(items);
    const elapsedMs = performance.now() - start;

    expect(Object.keys(counts)).toHaveLength(N);
    // item-0 sits at the root of the long chain, so it should be blocked
    // (directly or transitively) by nearly every other item.
    expect(counts['item-0'].directBlocks + counts['item-0'].indirectBlocks).toBeGreaterThan(N * 0.9);
    expect(elapsedMs).toBeLessThan(2000);
  });
});

describe('computeChainLengths', () => {
  it('gives zero for items nothing requires', () => {
    const items = { a: item({ id: 'a' }), b: item({ id: 'b' }) };
    const chains = computeChainLengths(items);
    expect(chains['a']).toBe(0);
    expect(chains['b']).toBe(0);
  });

  it('gives 1 for an item with a single direct requirer', () => {
    const items = {
      a: item({ id: 'a' }),
      b: item({ id: 'b', requires: ['a'] }),
    };
    const chains = computeChainLengths(items);
    expect(chains['a']).toBe(1);
    expect(chains['b']).toBe(0);
  });

  it('grows with a serial chain: c requires b requires a', () => {
    const items = {
      a: item({ id: 'a' }),
      b: item({ id: 'b', requires: ['a'] }),
      c: item({ id: 'c', requires: ['b'] }),
    };
    const chains = computeChainLengths(items);
    expect(chains['a']).toBe(2);
    expect(chains['b']).toBe(1);
    expect(chains['c']).toBe(0);
  });

  it('takes the longest branch, not the sum, when multiple chains fan out', () => {
    // a is required by both b (short branch, length 1 beyond b) and by a longer
    // chain c -> d -> e. a's chain length should reflect the longer branch.
    const items = {
      a: item({ id: 'a' }),
      b: item({ id: 'b', requires: ['a'] }),
      c: item({ id: 'c', requires: ['a'] }),
      d: item({ id: 'd', requires: ['c'] }),
      e: item({ id: 'e', requires: ['d'] }),
    };
    const chains = computeChainLengths(items);
    expect(chains['a']).toBe(3); // a -> c -> d -> e
    expect(chains['b']).toBe(0);
  });

  it('does not infinite-loop on a requires cycle', () => {
    const items = {
      a: item({ id: 'a', requires: ['b'] }),
      b: item({ id: 'b', requires: ['a'] }),
    };
    expect(() => computeChainLengths(items)).not.toThrow();
  });
});
