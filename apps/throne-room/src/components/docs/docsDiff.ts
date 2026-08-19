/**
 * Pure block-then-word diff for the docs diff view. No ProseMirror or DOM
 * dependency here — see diffHighlightExtension.ts for how this is wired into
 * live document decorations. Two-level algorithm per docs/design/docs-diff-view.md:
 * an LCS-style array diff over stringified top-level blocks identifies the
 * unchanged anchors, then within each stretch of blocks that changed, a
 * similarity-based sequence alignment (see alignRun below) pairs a removed
 * block with an added block whenever they're similar enough to be "the same
 * paragraph, edited" rather than an unrelated deletion plus an unrelated
 * addition — the common case of editing one paragraph while a neighboring
 * one is deleted or another is added nearby.
 *
 * Every entry carries baseIndex/currentIndex (into the original arrays
 * passed to diffBlocks) so a caller — the revert feature in
 * diffHighlightExtension.ts — can map an entry back to the exact base node
 * or live document position it came from.
 */
import { diffArrays, diffWords } from 'diff';

export interface WordDiffPart {
  kind: 'unchanged' | 'added' | 'removed';
  text: string;
}

export type BlockDiffEntry =
  | { kind: 'unchanged'; text: string; baseIndex: number; currentIndex: number }
  | { kind: 'added'; text: string; currentIndex: number }
  | { kind: 'removed'; text: string; baseIndex: number }
  | { kind: 'changed'; baseText: string; currentText: string; words: WordDiffPart[]; baseIndex: number; currentIndex: number };

function diffWordsWithinBlock(baseText: string, currentText: string): WordDiffPart[] {
  return diffWords(baseText, currentText).map((part) => ({
    kind: part.added ? 'added' : part.removed ? 'removed' : 'unchanged',
    text: part.value,
  }));
}

/** Dice-coefficient-style similarity in [0, 1] over the shared (unchanged) word content. */
function blockSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  let shared = 0;
  for (const part of diffWords(a, b)) {
    if (!part.added && !part.removed) shared += part.value.length;
  }
  return (2 * shared) / (a.length + b.length);
}

// Below this, two blocks are treated as unrelated rather than "the same
// paragraph, edited" — pairing them as a word-diff would read as noise.
const SIMILARITY_THRESHOLD = 0.3;
// Deleting one block and inserting an unrelated one costs 2 (1 deletion +
// 1 insertion); a substitution's cost scales with dissimilarity so the
// alignment only prefers pairing over separate remove/add when the blocks
// are actually similar.
const SUBSTITUTION_SCALE = 2;

/**
 * Aligns a contiguous run of removed blocks against a contiguous run of
 * added blocks (as produced by one removed-change immediately followed by
 * one added-change from `diffArrays`) using minimum-cost sequence
 * alignment — the same shape as a Levenshtein edit script, except a
 * "substitution" here means "paired as one changed block" and its cost is
 * driven by dissimilarity rather than being a flat 1. This is what lets a
 * block that moved slightly out of position, or has an unrelated deletion
 * next to it, still find its true match instead of the whole run collapsing
 * into one big delete-everything-then-add-everything hunk.
 *
 * The returned entries are ordered so that, read left to right and with
 * 'removed' entries filtered out, the remaining ('unchanged'/'added'/
 * 'changed') entries appear in exactly `added`'s order — required by the
 * caller, which maps entries back onto live document positions in that order.
 *
 * @param baseOffset - index of removed[0] in the original base array
 * @param currentOffset - index of added[0] in the original current array
 */
function alignRun(removed: string[], added: string[], baseOffset: number, currentOffset: number): BlockDiffEntry[] {
  const n = removed.length;
  const m = added.length;

  // cost[i][j] = cheapest way to turn removed[0..i) into added[0..j)
  const cost: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  const choice: Array<Array<'sub' | 'del' | 'ins' | ''>> = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => '' as const));

  for (let i = 1; i <= n; i++) {
    cost[i][0] = i;
    choice[i][0] = 'del';
  }
  for (let j = 1; j <= m; j++) {
    cost[0][j] = j;
    choice[0][j] = 'ins';
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const similarity = blockSimilarity(removed[i - 1], added[j - 1]);
      const subCost = similarity >= SIMILARITY_THRESHOLD ? cost[i - 1][j - 1] + SUBSTITUTION_SCALE * (1 - similarity) : Infinity;
      const delCost = cost[i - 1][j] + 1;
      const insCost = cost[i][j - 1] + 1;
      const best = Math.min(subCost, delCost, insCost);
      cost[i][j] = best;
      choice[i][j] = best === subCost ? 'sub' : best === delCost ? 'del' : 'ins';
    }
  }

  const ops: BlockDiffEntry[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const step = i > 0 && j > 0 ? choice[i][j] : i > 0 ? 'del' : 'ins';
    if (step === 'sub') {
      ops.push({
        kind: 'changed',
        baseText: removed[i - 1],
        currentText: added[j - 1],
        words: diffWordsWithinBlock(removed[i - 1], added[j - 1]),
        baseIndex: baseOffset + i - 1,
        currentIndex: currentOffset + j - 1,
      });
      i--;
      j--;
    } else if (step === 'del') {
      ops.push({ kind: 'removed', text: removed[i - 1], baseIndex: baseOffset + i - 1 });
      i--;
    } else {
      ops.push({ kind: 'added', text: added[j - 1], currentIndex: currentOffset + j - 1 });
      j--;
    }
  }
  ops.reverse();
  return ops;
}

/**
 * Diffs two arrays of block text (one per top-level document node) and
 * returns an ordered list of entries describing each block's change status.
 */
export function diffBlocks(baseBlocks: string[], currentBlocks: string[]): BlockDiffEntry[] {
  const changes = diffArrays(baseBlocks, currentBlocks);
  const entries: BlockDiffEntry[] = [];
  let baseIdx = 0;
  let currentIdx = 0;

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    if (!change.added && !change.removed) {
      for (const text of change.value) {
        entries.push({ kind: 'unchanged', text, baseIndex: baseIdx, currentIndex: currentIdx });
        baseIdx++;
        currentIdx++;
      }
      continue;
    }

    if (change.removed) {
      const next = changes[i + 1];
      if (next?.added) {
        entries.push(...alignRun(change.value, next.value, baseIdx, currentIdx));
        baseIdx += change.value.length;
        currentIdx += next.value.length;
        i++; // consumed the paired "added" change too
        continue;
      }
      for (const text of change.value) {
        entries.push({ kind: 'removed', text, baseIndex: baseIdx });
        baseIdx++;
      }
      continue;
    }

    // change.added, with no preceding unpaired removed run
    for (const text of change.value) {
      entries.push({ kind: 'added', text, currentIndex: currentIdx });
      currentIdx++;
    }
  }

  return entries;
}
