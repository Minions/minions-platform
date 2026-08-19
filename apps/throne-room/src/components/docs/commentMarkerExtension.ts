import { Extension } from '@tiptap/vue-3';
import { Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { matchCommentMarker } from './commentMarker';

const pluginKey = new PluginKey('commentMarker');

function buildControls(view: EditorView, from: number, to: number): HTMLElement {
  const wrapper = document.createElement('span');
  wrapper.className = 'docs-comment-marker__controls';
  wrapper.contentEditable = 'false';

  const resolveBtn = document.createElement('button');
  resolveBtn.type = 'button';
  resolveBtn.className = 'docs-comment-marker__control docs-comment-marker__control--resolve';
  resolveBtn.textContent = 'Resolve';
  resolveBtn.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    view.dispatch(view.state.tr.delete(from, to));
  });

  const replyBtn = document.createElement('button');
  replyBtn.type = 'button';
  replyBtn.className = 'docs-comment-marker__control docs-comment-marker__control--reply';
  replyBtn.textContent = 'Reply';
  replyBtn.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    replyToCommentAt(view, to);
  });

  wrapper.appendChild(resolveBtn);
  wrapper.appendChild(replyBtn);
  return wrapper;
}

/** Inserts a fresh `@ai: ` marker paragraph at `pos` and places the cursor at the end of its prefix. */
export function insertCommentMarkerAt(view: EditorView, pos: number): void {
  const { state } = view;
  const paragraphType = state.schema.nodes.paragraph;
  // @<tag> names who the comment is TO, not who wrote it — a human writing a
  // fresh comment is addressing the AI, so the default tag is "ai".
  const marker = '@ai: ';
  const markerNode = paragraphType.create(null, state.schema.text(marker));
  let tr: Transaction = state.tr.insert(pos, markerNode);
  const cursorPos = pos + 1 + marker.length;
  tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
  view.dispatch(tr);
  view.focus();
}

/** Inserts a fresh `@ai: ` marker paragraph immediately after `afterPos` and focuses it. */
export function replyToCommentAt(view: EditorView, afterPos: number): void {
  insertCommentMarkerAt(view, afterPos);
}

interface TagPrefixHit {
  /** Position right after the block's opening — start of its text content. */
  blockStart: number;
  /** Position at the end of the block's text content. */
  blockEnd: number;
  /** Position right after the matched `@tag: ` prefix — start of the comment body. */
  prefixEnd: number;
}

/** Resolves whether `pos` falls inside a comment block's `@tag: ` prefix, and if so, its bounds. */
function findTagPrefixHit(doc: ProseMirrorNode, pos: number): TagPrefixHit | null {
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;
  const match = matchCommentMarker(parent.textContent);
  if (!match || match.prefix.length === 0) return null;

  const blockStart = $pos.start();
  const prefixEnd = blockStart + match.prefix.length;
  if (pos < blockStart || pos >= prefixEnd) return null;
  return { blockStart, blockEnd: $pos.end(), prefixEnd };
}

/**
 * A single click landing inside a `@tag: ` prefix is redirected to just past it
 * (start of the comment body) so an ordinary click near the badge can't silently
 * corrupt the tag. Editing the tag itself is still possible — double-click it, or
 * click it again once the cursor is already inside the comment's body text.
 *
 * Intercepted on `mousedown`, not `handleClick` (which ProseMirror only calls on
 * the following `mouseup`/`click`): a contenteditable browser assigns its native
 * DOM selection on mousedown itself, before any later ProseMirror event fires.
 * Redirecting the ProseMirror selection afterward doesn't reliably win against
 * that native placement — ProseMirror's DOM-selection sync can lose the race, so
 * typed keystrokes still land at the raw click point. `preventDefault()` here
 * stops the browser from ever assigning that native selection in the first place.
 */
function handleCommentMarkerMouseDown(view: EditorView, event: MouseEvent): boolean {
  if (event.detail >= 2) return false;

  const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!coords) return false;

  const hit = findTagPrefixHit(view.state.doc, coords.pos);
  if (!hit) return false;

  const { anchor, empty } = view.state.selection;
  // Strictly past prefixEnd: a cursor resting exactly at prefixEnd is the
  // marker's own just-inserted default focus position (empty body), not
  // evidence the user is actively editing real comment content.
  const alreadyEditingHere = empty && anchor > hit.prefixEnd && anchor <= hit.blockEnd;
  if (alreadyEditingHere) return false;

  event.preventDefault();
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, hit.prefixEnd)));
  view.focus();
  return true;
}

function buildDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    const match = matchCommentMarker(node.textContent);
    if (!match) return;

    const from = pos;
    const to = pos + node.nodeSize;
    const textStart = pos + 1;
    const prefixEnd = textStart + match.prefix.length;

    decorations.push(
      Decoration.node(from, to, {
        class: 'docs-comment-marker',
        'data-comment-tag': match.tag,
      }),
    );

    if (match.prefix.length > 0) {
      // Stays visible (real text, not hidden/replaced) — hiding decorated
      // text via CSS breaks ProseMirror's DOM<->position coordinate mapping,
      // making clicks/typing inside the block land at the wrong position.
      decorations.push(Decoration.inline(textStart, prefixEnd, { class: 'docs-comment-marker__tag' }));
    }

    decorations.push(
      Decoration.widget(to - 1, (view) => buildControls(view, from, to), {
        side: 1,
        key: `comment-controls-${from}`,
      }),
    );
  });

  return DecorationSet.create(doc, decorations);
}

export const CommentMarker = Extension.create({
  name: 'commentMarker',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: pluginKey,
        props: {
          decorations(state) {
            return buildDecorations(state.doc);
          },
          handleDOMEvents: {
            mousedown: handleCommentMarkerMouseDown,
          },
        },
      }),
    ];
  },
});
