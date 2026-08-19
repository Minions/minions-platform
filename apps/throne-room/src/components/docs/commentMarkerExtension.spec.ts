import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/vue-3';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import { CommentMarker, insertCommentMarkerAt } from './commentMarkerExtension';

function createEditor(html: string): Editor {
  return new Editor({
    extensions: [StarterKit, CommentMarker],
    content: html,
  });
}

/**
 * jsdom has no real layout, so `view.posAtCoords` can't resolve pixel
 * coordinates to a doc position the way a real browser does. Stub it to
 * return `pos` for this call, then dispatch a synthetic mousedown — this
 * exercises the same `handleDOMEvents.mousedown` codepath a real click uses.
 */
function mousedownAt(view: EditorView, pos: number, detail: number): boolean {
  const original = view.posAtCoords;
  view.posAtCoords = () => ({ pos, inside: -1 });
  try {
    const event = new MouseEvent('mousedown', { detail, clientX: 0, clientY: 0 });
    return !!view.someProp('handleDOMEvents', (handlers) => handlers.mousedown?.(view, event));
  } finally {
    view.posAtCoords = original;
  }
}

describe('CommentMarker decorations', () => {
  let editor: Editor | undefined;

  afterEach(() => {
    editor?.destroy();
    editor = undefined;
  });

  it('marks a paragraph starting with @tag: as a comment and styles its prefix, without hiding any text', () => {
    editor = createEditor('<p>@ai: rework this paragraph</p>');
    const dom = editor.view.dom;

    const marker = dom.querySelector('.docs-comment-marker');
    expect(marker).not.toBeNull();
    expect(marker?.getAttribute('data-comment-tag')).toBe('ai');

    const tag = marker?.querySelector('.docs-comment-marker__tag');
    expect(tag?.textContent).toBe('@ai: ');

    // The prefix must stay real, visible text — hiding it via CSS breaks
    // ProseMirror's DOM<->position mapping (clicks/typing land in the wrong place).
    expect(marker?.textContent).toContain('@ai: rework this paragraph');
  });

  it('does not mark an ordinary paragraph', () => {
    editor = createEditor('<p>Just a normal paragraph.</p>');
    expect(editor.view.dom.querySelector('.docs-comment-marker')).toBeNull();
  });

  it('renders Resolve/Reply controls for a comment paragraph', () => {
    editor = createEditor('<p>@human: which one do you want?</p>');
    const marker = editor.view.dom.querySelector('.docs-comment-marker');
    expect(marker?.querySelector('.docs-comment-marker__control--resolve')).not.toBeNull();
    expect(marker?.querySelector('.docs-comment-marker__control--reply')).not.toBeNull();
  });

  it('Resolve removes the comment paragraph from the document', () => {
    editor = createEditor('<p>@ai: delete me</p><p>keep me</p>');
    const resolveBtn = editor.view.dom.querySelector<HTMLButtonElement>('.docs-comment-marker__control--resolve');
    resolveBtn?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(editor.getText()).not.toContain('delete me');
    expect(editor.getText()).toContain('keep me');
  });

  it('Reply inserts a new @ai: marker paragraph right after the comment', () => {
    editor = createEditor('<p>@ai: original comment</p><p>body text</p>');
    const replyBtn = editor.view.dom.querySelector<HTMLButtonElement>('.docs-comment-marker__control--reply');
    replyBtn?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    const paragraphs = Array.from(editor.view.dom.querySelectorAll('p'));
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0]?.getAttribute('data-comment-tag')).toBe('ai');
    expect(paragraphs[0]?.textContent).toContain('original comment');
    expect(paragraphs[1]?.getAttribute('data-comment-tag')).toBe('ai');
    expect(paragraphs[2]?.getAttribute('data-comment-tag')).toBeNull();
    expect(paragraphs[2]?.textContent).toContain('body text');

    expect(editor.getText()).toContain('@ai:');
  });

  it('insertCommentMarkerAt inserts a marker at the given position and places the cursor after its prefix', () => {
    editor = createEditor('<h1>Starting heading</h1><p>body text</p>');
    const afterHeading = editor.state.doc.child(0).nodeSize;

    insertCommentMarkerAt(editor.view, afterHeading);
    editor.commands.insertContent('typed right after the marker');

    const marker = editor.view.dom.querySelector('.docs-comment-marker');
    expect(marker?.getAttribute('data-comment-tag')).toBe('ai');
    expect(marker?.textContent).toContain('typed right after the marker');

    const blocks = Array.from(editor.view.dom.querySelectorAll('h1, p')).map((el) => el.tagName);
    expect(blocks).toEqual(['H1', 'P', 'P']);
  });

  it('typing right after inserting a marker lands inside the marker, not elsewhere in the doc', () => {
    editor = createEditor('<h1>Starting heading</h1><p>body text</p>');
    const afterHeading = editor.state.doc.child(0).nodeSize;

    insertCommentMarkerAt(editor.view, afterHeading);
    const { $from } = editor.state.selection;
    editor.view.dispatch(editor.state.tr.insertText('typed via the resolved cursor position', $from.pos));

    expect(editor.getText()).toMatch(/@ai: typed via the resolved cursor position/);
  });

  it('recomputes decorations live as the user types a marker', () => {
    editor = createEditor('<p></p>');
    editor.commands.insertContent('@human: typed live');
    const marker = editor.view.dom.querySelector('.docs-comment-marker');
    expect(marker).not.toBeNull();
    expect(marker?.getAttribute('data-comment-tag')).toBe('human');
  });

  it('a single click inside the @tag: prefix redirects the cursor past it, instead of letting typing corrupt the tag', () => {
    editor = createEditor('<p>@ai: rework this paragraph</p>');
    const blockStart = editor.state.doc.resolve(1).start();
    // Click between "a" and "i" of "@ai: " — right in the middle of the tag.
    const clickPos = blockStart + 2;

    const handled = mousedownAt(editor.view, clickPos, 1);
    expect(handled).toBe(true);

    editor.view.dispatch(editor.state.tr.insertText('hello ', editor.state.selection.from));

    expect(editor.getText()).toMatch(/^@ai: hello rework this paragraph/);
    const marker = editor.view.dom.querySelector('.docs-comment-marker');
    expect(marker?.getAttribute('data-comment-tag')).toBe('ai');
  });

  it('a double click inside the @tag: prefix is left alone, so the tag itself can still be edited intentionally', () => {
    editor = createEditor('<p>@ai: rework this paragraph</p>');
    const blockStart = editor.state.doc.resolve(1).start();
    const clickPos = blockStart + 2;

    const handled = mousedownAt(editor.view, clickPos, 2);
    expect(handled).toBeFalsy();
  });

  it('a click inside the @tag: prefix is left alone once the cursor is already inside the comment body text', () => {
    editor = createEditor('<p>@ai: rework this paragraph</p>');
    const blockStart = editor.state.doc.resolve(1).start();
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, blockStart + 6)));

    const clickPos = blockStart + 2;
    const handled = mousedownAt(editor.view, clickPos, 1);
    expect(handled).toBeFalsy();
  });

  it('a click on the tag right after inserting a fresh, still-empty marker still redirects safely, instead of treating the insert-time focus as "already editing"', () => {
    editor = createEditor('<p>body text</p>');
    insertCommentMarkerAt(editor.view, 0);
    // insertCommentMarkerAt leaves the cursor right at the end of "@ai: " (an
    // empty body) — that must not itself count as "already editing content".
    const blockStart = editor.state.selection.$from.start();
    const clickPos = blockStart + 2;

    const handled = mousedownAt(editor.view, clickPos, 1);
    expect(handled).toBe(true);

    editor.view.dispatch(editor.state.tr.insertText('hello ', editor.state.selection.from));
    expect(editor.getText()).toMatch(/^@ai: hello /);
  });
});
