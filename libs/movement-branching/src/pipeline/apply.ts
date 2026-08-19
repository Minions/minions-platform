import { createHash } from 'node:crypto';
import type { Worktree } from '@minions/file-store';
import type { TextChange } from './types.js';
import type { CombinedChanges } from './combine.js';

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface ApplyResult {
  /** Files actually patched on disk. */
  patchedFiles: string[];
  /**
   * Edits that could not be safely applied because the file changed since the
   * edit was computed against it — surfaced, never silently misapplied.
   */
  staleEdits: TextChange[];
}

/**
 * The pipeline's sink: performs the real mutation against the changeset.
 * Detectors and Recognizers only ever produce terms; this is the only place
 * that touches real state. Every edit is re-checked against the file's
 * current content hash immediately before writing — never applied blind.
 */
export async function applyTextChanges(worktree: Worktree, accepted: Map<string, TextChange[]>): Promise<ApplyResult> {
  const patchedFiles: string[] = [];
  const staleEdits: TextChange[] = [];

  for (const [file, edits] of accepted) {
    if (edits.length === 0) continue;

    const found = await worktree.child(file);
    if (!found.found || found.node.kind !== 'file') {
      staleEdits.push(...edits);
      continue;
    }

    const content = await found.node.read();
    const currentHash = hashContent(content);

    const validEdits = edits.filter((e) => e.value.baseContentHash === currentHash);
    const invalidEdits = edits.filter((e) => e.value.baseContentHash !== currentHash);
    staleEdits.push(...invalidEdits);
    if (validEdits.length === 0) continue;

    // validEdits is already sorted by range end descending (from mergeTextChanges) —
    // applying end-to-start keeps earlier edits' offsets valid.
    let patched = content;
    for (const edit of validEdits) {
      const [start, end] = edit.value.range;
      patched = patched.slice(0, start) + edit.value.replacement + patched.slice(end);
    }

    await found.node.write(patched);
    patchedFiles.push(file);
  }

  return { patchedFiles, staleEdits };
}

export { type CombinedChanges };
