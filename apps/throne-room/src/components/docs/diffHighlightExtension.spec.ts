import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/vue-3';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { DiffHighlight, setDiffBase, setDiffEnabled } from './diffHighlightExtension';

function createEditor(html: string): Editor {
  return new Editor({
    extensions: [StarterKit, DiffHighlight],
    content: html,
  });
}

/** Builds plain-paragraph base nodes for tests that don't exercise revert (where node type doesn't matter, only text). */
function paragraphNodes(editor: Editor, texts: string[]): ProseMirrorNode[] {
  return texts.map((text) => editor.schema.nodes.paragraph.create(null, text ? editor.schema.text(text) : undefined));
}

describe('DiffHighlight decorations', () => {
  let editor: Editor | undefined;

  afterEach(() => {
    editor?.destroy();
    editor = undefined;
  });

  it('renders nothing when disabled, even with a base set', () => {
    editor = createEditor('<p>the slow fox</p>');
    setDiffBase(editor, ['the quick fox'], paragraphNodes(editor, ['the quick fox']));

    expect(editor.view.dom.querySelector('.docs-diff-added')).toBeNull();
    expect(editor.view.dom.querySelector('.docs-diff-removed')).toBeNull();
  });

  it('highlights an added word and inserts a removed-word widget for a changed paragraph', () => {
    editor = createEditor('<p>the slow fox</p>');
    setDiffBase(editor, ['the quick fox'], paragraphNodes(editor, ['the quick fox']));
    setDiffEnabled(editor, true);

    const added = editor.view.dom.querySelector('.docs-diff-added');
    expect(added?.textContent).toBe('slow');

    const removed = editor.view.dom.querySelector('.docs-diff-removed');
    expect(removed?.textContent).toBe('-quick');
    expect(removed?.classList.contains('docs-diff-removed--word')).toBe(true);
    expect(removed?.tagName).toBe('SPAN');
  });

  it('highlights a whole new paragraph as added with the same block-level treatment as a removal, on the real node (not a widget)', () => {
    editor = createEditor('<p>first</p><p>second</p>');
    setDiffBase(editor, ['first'], paragraphNodes(editor, ['first']));
    setDiffEnabled(editor, true);

    expect(editor.view.dom.querySelector('.docs-diff-added')).toBeNull();
    const added = editor.view.dom.querySelectorAll('.docs-diff-added-block');
    expect(added.length).toBe(1);
    expect(added[0]?.tagName).toBe('P');
    expect(added[0]?.textContent).toContain('second');
    // Revert control sits inside the block, at its start (left side).
    expect(added[0]?.querySelector('.docs-diff-revert-btn')).not.toBeNull();
  });

  it('inserts a removed-paragraph widget for a base paragraph no longer present', () => {
    editor = createEditor('<p>keep me</p>');
    setDiffBase(editor, ['keep me', 'gone paragraph'], paragraphNodes(editor, ['keep me', 'gone paragraph']));
    setDiffEnabled(editor, true);

    const removed = editor.view.dom.querySelector('.docs-diff-removed');
    expect(removed?.querySelector('span')?.textContent).toBe('-gone paragraph');
    expect(removed?.classList.contains('docs-diff-removed--block')).toBe(true);
    expect(removed?.tagName).toBe('DIV');
  });

  it('regression: editing a title right before a deleted paragraph matches the title to itself, not a bulk delete+create', () => {
    editor = createEditor('<h1>CodeWarp Suite (renamed)</h1><p>Get started</p>');
    const base1 = ['CodeWarp Suite', 'This paragraph gets deleted entirely.', 'Get started'];
    setDiffBase(editor, base1, paragraphNodes(editor, base1));
    setDiffEnabled(editor, true);

    const added = editor.view.dom.querySelectorAll('.docs-diff-added');
    expect(added.length).toBe(1);
    expect(added[0]?.textContent).toBe('(renamed)');

    const removedBlocks = editor.view.dom.querySelectorAll('.docs-diff-removed--block');
    expect(removedBlocks.length).toBe(1);
    expect(removedBlocks[0]?.querySelector('span')?.textContent).toBe('-This paragraph gets deleted entirely.');

    // The title heading itself must not be wrapped in a whole-block removed/added marker.
    expect(editor.view.dom.querySelectorAll('.docs-diff-changed-block').length).toBe(0);
  });

  it('regression: an ordered list is diffed item-by-item, not as one opaque block (adding a step after an unrelated one leaves it alone)', () => {
    editor = createEditor(
      '<ol><li><p>Install Node.js.</p></li><li><p>Install pnpm and nx.</p></li>' +
        '<li><p>Install dependencies</p></li><li><p>And a bit more.</p></li><li><p>Build The Smith</p></li></ol>',
    );
    const base2 = ['Install Node.js.', 'Install pnpm and nx.', 'Install dependencies', 'Build The Smith'];
    setDiffBase(editor, base2, paragraphNodes(editor, base2));
    setDiffEnabled(editor, true);

    // Only the genuinely new item is added — the untouched steps around it
    // (including "Install dependencies", which sits right next to the
    // insertion point) must show no decoration at all.
    const added = editor.view.dom.querySelectorAll('.docs-diff-added-block');
    expect(added.length).toBe(1);
    expect(added[0]?.textContent).toContain('And a bit more.');
    expect(editor.view.dom.querySelector('.docs-diff-removed')).toBeNull();
  });

  it('regression: deleting one word inside a list item does a word-level diff, not a whole-block fallback', () => {
    editor = createEditor('<ol><li><p>See the build products in the folder.</p></li></ol>');
    const base3 = ['See the build products in the dist folder.'];
    setDiffBase(editor, base3, paragraphNodes(editor, base3));
    setDiffEnabled(editor, true);

    const removedWord = editor.view.dom.querySelector('.docs-diff-removed--word');
    expect(removedWord?.textContent).toBe('-dist ');
    expect(editor.view.dom.querySelector('.docs-diff-removed--block')).toBeNull();
  });

  it('regression: an unmodified list item next to an edited/removed sibling gets no decoration', () => {
    editor = createEditor('<ol><li><p>Install pnpm and nx.</p></li></ol>');
    const base4 = ['Install Node.js.', 'Install pnpm and nx.'];
    setDiffBase(editor, base4, paragraphNodes(editor, base4));
    setDiffEnabled(editor, true);

    // "Install Node.js." was removed; "Install pnpm and nx." is untouched
    // and must carry no decoration of its own.
    const removed = editor.view.dom.querySelectorAll('.docs-diff-removed');
    expect(removed.length).toBe(1);
    expect(removed[0]?.querySelector('span')?.textContent).toBe('-Install Node.js.');
    expect(editor.view.dom.querySelectorAll('.docs-diff-added').length).toBe(0);
  });

  it('regression: does not report StarterKit\'s trailing empty paragraph (after a list) as a spurious added block', () => {
    editor = createEditor('<ol><li><p>Install Node.js.</p></li><li><p>Install pnpm and nx.</p></li></ol>');
    const base = ['Install Node.js.', 'Install pnpm and nx.'];
    setDiffBase(editor, base, paragraphNodes(editor, base));
    setDiffEnabled(editor, true);

    expect(editor.view.dom.querySelectorAll('.docs-diff-added-block').length).toBe(0);
    expect(editor.view.dom.querySelector('.docs-diff-added')).toBeNull();
    expect(editor.view.dom.querySelector('.docs-diff-removed')).toBeNull();
  });

  it('places the revert control in the same (left/first) position for both an added block and a removed block', () => {
    editor = createEditor('<p>keep me</p><p>xylophone quokka banana</p>');
    const base = ['keep me', 'umbrella glacier falcon'];
    setDiffBase(editor, base, paragraphNodes(editor, base));
    setDiffEnabled(editor, true);

    const addedBlock = editor.view.dom.querySelector('.docs-diff-added-block');
    expect(addedBlock?.firstElementChild?.classList.contains('docs-diff-revert-btn')).toBe(true);

    const removedBlock = editor.view.dom.querySelector('.docs-diff-removed--block');
    expect(removedBlock?.firstElementChild?.classList.contains('docs-diff-revert-btn')).toBe(true);
  });

  it('reverting a removed block re-inserts its base content', () => {
    editor = createEditor('<p>keep me</p>');
    setDiffBase(editor, ['keep me', 'gone paragraph'], paragraphNodes(editor, ['keep me', 'gone paragraph']));
    setDiffEnabled(editor, true);

    const revertBtn = editor.view.dom.querySelector('.docs-diff-removed--block .docs-diff-revert-btn');
    expect(revertBtn).not.toBeNull();
    revertBtn?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(
      editor
        .getText()
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    ).toEqual(['keep me', 'gone paragraph']);
  });

  it('reverting an added block removes it entirely', () => {
    editor = createEditor('<p>first</p><p>second</p>');
    setDiffBase(editor, ['first'], paragraphNodes(editor, ['first']));
    setDiffEnabled(editor, true);
    expect(editor.getText()).toContain('second');

    const revertBtn = editor.view.dom.querySelector('.docs-diff-revert-btn');
    expect(revertBtn).not.toBeNull();
    revertBtn?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(editor.getText().trim()).toBe('first');
  });

  it('reverting a changed block restores its base content, including its original node type (heading, not paragraph)', () => {
    editor = createEditor('<h1>CodeWarp Suite (renamed)</h1>');
    const headingNode = editor.schema.nodes.heading.create({ level: 1 }, editor.schema.text('CodeWarp Suite'));
    setDiffBase(editor, ['CodeWarp Suite'], [headingNode]);
    setDiffEnabled(editor, true);

    const revertBtn = editor.view.dom.querySelector('.docs-diff-revert-btn');
    expect(revertBtn).not.toBeNull();
    revertBtn?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(editor.getText().trim()).toBe('CodeWarp Suite');
    expect(editor.getJSON().content?.[0]?.type).toBe('heading');
  });

  it('turning diff off removes all decorations without touching the document', () => {
    editor = createEditor('<p>the slow fox</p>');
    setDiffBase(editor, ['the quick fox'], paragraphNodes(editor, ['the quick fox']));
    setDiffEnabled(editor, true);
    expect(editor.view.dom.querySelector('.docs-diff-added')).not.toBeNull();

    setDiffEnabled(editor, false);

    expect(editor.view.dom.querySelector('.docs-diff-added')).toBeNull();
    expect(editor.getText()).toBe('the slow fox');
  });
});
