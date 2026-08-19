import type { PlanItem } from '@minions/planner-types';

export interface BlockCounts {
  /** Items whose `requires` list directly names this id. */
  directBlocks: number;
  /**
   * Items that reach this id transitively through some chain of `requires`
   * edges, deduped so an item reachable via multiple paths (or both directly
   * and transitively) is counted once, in whichever of directBlocks /
   * indirectBlocks its shortest relationship earns it. An item already
   * counted in directBlocks is never also counted in indirectBlocks.
   */
  indirectBlocks: number;
}

/**
 * For every id in `items`, count how many other items are blocked on it,
 * following the `requires` graph in reverse (an item X "blocks" id when X
 * requires id, directly or transitively through other requires).
 *
 * Cycle-safe: a `requires` cycle cannot inflate counts or infinite-loop —
 * each item contributes at most once to another item's block counts.
 */
export function computeBlockCounts(items: Record<string, PlanItem>): Record<string, BlockCounts> {
  // Map ids to dense indices so the graph walk below works over typed arrays
  // instead of string-keyed Sets/Maps — string hashing otherwise dominates
  // the cost at realistic plan sizes (see the perf test in blockCounts.test.ts).
  const ids = Object.keys(items);
  const indexOf = new Map<string, number>(ids.map((id, i) => [id, i]));
  const n = ids.length;

  // requiredBy[i] = indices of items that directly require ids[i].
  const requiredBy: number[][] = Array.from({ length: n }, () => []);
  for (const item of Object.values(items)) {
    const from = indexOf.get(item.id);
    if (from === undefined) continue;
    for (const dep of item.requires) {
      const to = indexOf.get(dep);
      if (to === undefined) continue;
      requiredBy[to].push(from);
    }
  }

  // Reusable "visited" buffer, stamped with a generation number per node so
  // it never needs to be cleared (an O(n) reset per node would itself be the
  // bottleneck at scale).
  const visitedGen = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  const result: Record<string, BlockCounts> = {};

  for (let id = 0; id < n; id++) {
    const direct = requiredBy[id];
    let directCount = 0;
    let reachableCount = 0;
    stack.length = 0;

    for (const from of direct) {
      if (visitedGen[from] === id) continue;
      visitedGen[from] = id;
      directCount++;
      reachableCount++;
      stack.push(from);
    }

    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      for (const next of requiredBy[current]) {
        if (next === id || visitedGen[next] === id) continue;
        visitedGen[next] = id;
        reachableCount++;
        stack.push(next);
      }
    }

    result[ids[id]] = {
      directBlocks: directCount,
      indirectBlocks: reachableCount - directCount,
    };
  }
  return result;
}

/**
 * For every id in `items`, the length of the longest chain of items serially
 * blocked behind it — i.e. the longest path, following `requires` edges in
 * reverse, of items that (transitively) require id before they themselves can
 * be required by anything else.
 *
 * Used to break ties when multiple items free up the same amount of direct
 * parallel work: the one sitting deepest in a serial chain is worth doing
 * first, since nothing behind it can even start until it (and everything
 * ahead of it) is done.
 *
 * Cycle-safe: a node currently being visited contributes 0 back up its own
 * cycle instead of recursing forever.
 */
export function computeChainLengths(items: Record<string, PlanItem>): Record<string, number> {
  const ids = Object.keys(items);
  const indexOf = new Map<string, number>(ids.map((id, i) => [id, i]));
  const n = ids.length;

  const requiredBy: number[][] = Array.from({ length: n }, () => []);
  for (const item of Object.values(items)) {
    const from = indexOf.get(item.id);
    if (from === undefined) continue;
    for (const dep of item.requires) {
      const to = indexOf.get(dep);
      if (to === undefined) continue;
      requiredBy[to].push(from);
    }
  }

  const memo = new Int32Array(n).fill(-1);
  const visiting = new Uint8Array(n);

  function chainLength(i: number): number {
    if (memo[i] !== -1) return memo[i];
    if (visiting[i]) return 0;
    visiting[i] = 1;
    let max = 0;
    for (const requirer of requiredBy[i]) {
      const candidate = 1 + chainLength(requirer);
      if (candidate > max) max = candidate;
    }
    visiting[i] = 0;
    memo[i] = max;
    return max;
  }

  const result: Record<string, number> = {};
  for (let i = 0; i < n; i++) result[ids[i]] = chainLength(i);
  return result;
}
