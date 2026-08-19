import { Extension, type Editor } from '@tiptap/vue-3';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { diffBlocks } from './docsDiff';

export interface DiffHighlightStorage {
  enabled: boolean;
  baseBlocks: string[];
  /** Parsed base document nodes, one per baseBlocks entry — the source of truth for reverting a block back to its base content/formatting. */
  baseNodes: ProseMirrorNode[];
}

declare module '@tiptap/core' {
  interface Storage {
    diffHighlight: DiffHighlightStorage;
  }
}

const pluginKey = new PluginKey('diffHighlight');

export interface CurrentBlock {
  node: ProseMirrorNode;
  text: string;
  from: number;
  to: number;
}

/**
 * Diff units are textblocks (paragraph, heading, codeBlock — anything with
 * `isTextblock`), found at ANY depth, not just doc's direct children. A
 * naive depth-0 walk treats an entire list as one opaque block — since
 * `orderedList`/`bulletList`/`listItem` are structural containers, not
 * textblocks, this recurses through them (and blockquote) so each list
 * item's own paragraph/code block diffs independently. That also means
 * every collected block is guaranteed to be a real textblock, where content
 * offset === text offset — no separate "non-textblock" position-math
 * fallback is needed.
 *
 * Exported so DocsViewer.vue's base-content parse (a throwaway doc built
 * from the file's content at the diff base ref) uses the exact same block
 * segmentation as the live doc below — the two sides must agree on what a
 * "block" is, or diffBlocks' index correspondence breaks.
 *
 * Empty textblocks are skipped entirely — most importantly, StarterKit
 * auto-appends a trailing empty paragraph after a list/code block at the
 * end of the live document (so there's somewhere to click/type below it),
 * which the base-content parse never has. Left uncollected, that phantom
 * block showed up as a spurious "added" block on every doc ending in a
 * list or code block. There's nothing meaningful to diff in an empty block
 * either way.
 */
export function collectDiffBlocks(container: ProseMirrorNode, contentStart: number, blocks: CurrentBlock[]): void {
  container.forEach((child, childOffset) => {
    const pos = contentStart + childOffset;
    if (child.isTextblock) {
      if (child.textContent.trim() !== '') blocks.push({ node: child, text: child.textContent, from: pos, to: pos + child.nodeSize });
    } else if (child.isBlock && child.content.size > 0) {
      collectDiffBlocks(child, pos + 1, blocks);
    }
  });
}

function revertButton(title: string, onClick: () => void): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'docs-diff-revert-btn';
  button.title = title;
  button.textContent = '↩';
  button.contentEditable = 'false';
  button.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

/**
 * A whole removed BLOCK renders as its own block-level element (own line,
 * wraps, preserves line breaks within the removed text) so a multi-block
 * deletion still reads as "these were separate paragraphs" instead of being
 * squashed into one run-on inline span. A removed WORD/phrase inside an
 * otherwise-changed block stays a small inline span so it reads in place,
 * mid-sentence. A block-level removal also carries a revert control to
 * restore it; a word-level removal doesn't (its parent block's revert
 * control covers it).
 */
function removedWidget(text: string, kind: 'block' | 'word', onRevert?: () => void): HTMLElement {
  const el = document.createElement(kind === 'block' ? 'div' : 'span');
  el.className = kind === 'block' ? 'docs-diff-removed docs-diff-removed--block' : 'docs-diff-removed docs-diff-removed--word';
  el.contentEditable = 'false';
  // Revert control first (left side) — matches where the added/changed
  // blocks' revert control sits, so the control is always in the same place
  // regardless of which kind of hunk it's reverting.
  if (onRevert) el.appendChild(revertButton('Restore this block', onRevert));
  const textSpan = document.createElement('span');
  textSpan.textContent = `-${text}`;
  el.appendChild(textSpan);
  return el;
}

function buildDecorations(doc: ProseMirrorNode, baseBlocks: string[], baseNodes: ProseMirrorNode[]): DecorationSet {
  const currentBlocks: CurrentBlock[] = [];
  collectDiffBlocks(doc, 0, currentBlocks);
  const entries = diffBlocks(baseBlocks, currentBlocks.map((b) => b.text));
  const decorations: Decoration[] = [];
  let blockIdx = 0;

  for (const entry of entries) {
    if (entry.kind === 'removed') {
      const pos = blockIdx < currentBlocks.length ? currentBlocks[blockIdx].from : doc.content.size;
      const baseNode = baseNodes[entry.baseIndex] as ProseMirrorNode | undefined;
      decorations.push(
        Decoration.widget(
          pos,
          (view: EditorView) =>
            removedWidget(
              entry.text,
              'block',
              baseNode ? () => view.dispatch(view.state.tr.insert(pos, baseNode.copy(baseNode.content))) : undefined,
            ),
          { side: -1, key: `diff-removed-block-${pos}-${entry.text.length}` },
        ),
      );
      continue;
    }

    const block = currentBlocks[blockIdx];
    blockIdx++;
    if (!block) continue;

    if (entry.kind === 'unchanged') continue;

    if (entry.kind === 'added') {
      // Block-level, same visual weight as a block-level removal (own
      // highlighted row, not just an inline color change) — this is real
      // document content, not a widget, so it still participates in real
      // list numbering etc. The revert control sits at the block's start
      // (left side), matching where a removed/changed block's control sits.
      decorations.push(Decoration.node(block.from, block.to, { class: 'docs-diff-added-block' }));
      const { from, to } = block;
      decorations.push(
        Decoration.widget(
          block.from + 1,
          (view: EditorView) => revertButton('Remove this addition', () => view.dispatch(view.state.tr.delete(from, to))),
          { side: -1, key: `diff-revert-added-${block.from}` },
        ),
      );
      continue;
    }

    // entry.kind === 'changed' — every collected block is a real textblock
    // (see collectBlocks), so content offset === text offset always holds.
    const baseNode = baseNodes[entry.baseIndex] as ProseMirrorNode | undefined;
    if (baseNode) {
      const { from, to } = block;
      decorations.push(
        Decoration.widget(
          block.from + 1,
          (view: EditorView) =>
            revertButton('Revert this block to its base content', () =>
              view.dispatch(view.state.tr.replaceWith(from, to, baseNode.copy(baseNode.content))),
            ),
          { side: -1, key: `diff-revert-changed-${block.from}` },
        ),
      );
    }

    let cursor = block.from + 1;
    for (const word of entry.words) {
      if (word.kind === 'unchanged') {
        cursor += word.text.length;
      } else if (word.kind === 'added') {
        decorations.push(Decoration.inline(cursor, cursor + word.text.length, { class: 'docs-diff-added' }));
        cursor += word.text.length;
      } else {
        decorations.push(
          Decoration.widget(cursor, () => removedWidget(word.text, 'word'), {
            side: -1,
            key: `diff-removed-word-${cursor}-${word.text.length}`,
          }),
        );
      }
    }
  }

  return DecorationSet.create(doc, decorations);
}

/** Sets the base content (as parallel arrays of top-level block texts and their parsed nodes) to diff the live document against, and re-renders. */
export function setDiffBase(editor: Editor, baseBlocks: string[], baseNodes: ProseMirrorNode[]): void {
  editor.storage.diffHighlight.baseBlocks = baseBlocks;
  editor.storage.diffHighlight.baseNodes = baseNodes;
  editor.view.dispatch(editor.view.state.tr.setMeta(pluginKey, true));
}

/** Turns the diff overlay on/off without touching the document or the recorded base. */
export function setDiffEnabled(editor: Editor, enabled: boolean): void {
  editor.storage.diffHighlight.enabled = enabled;
  editor.view.dispatch(editor.view.state.tr.setMeta(pluginKey, true));
}

export const DiffHighlight = Extension.create<Record<string, never>, DiffHighlightStorage>({
  name: 'diffHighlight',

  addStorage() {
    return { enabled: false, baseBlocks: [], baseNodes: [] };
  },

  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin({
        key: pluginKey,
        props: {
          decorations(state) {
            if (!storage.enabled) return DecorationSet.empty;
            return buildDecorations(state.doc, storage.baseBlocks, storage.baseNodes);
          },
        },
      }),
    ];
  },
});
