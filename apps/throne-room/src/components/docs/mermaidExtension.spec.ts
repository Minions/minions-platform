import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import { MermaidDiagram } from './mermaidExtension';

function createEditor(html: string): Editor {
  return new Editor({
    extensions: [StarterKit, MermaidDiagram],
    content: html,
  });
}

describe('MermaidDiagram decorations', () => {
  let editor: Editor | undefined;

  afterEach(() => {
    editor?.destroy();
    editor = undefined;
  });

  it('adds a diagram wrapper right after a ```mermaid code block', () => {
    editor = createEditor('<pre><code class="language-mermaid">graph TD; A--&gt;B;</code></pre>');
    const wrapper = editor.view.dom.querySelector<HTMLElement>('.docs-mermaid-wrapper');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.contentEditable).toBe('false');
  });

  it('does not add a diagram wrapper for a plain (non-mermaid) code block', () => {
    editor = createEditor('<pre><code class="language-typescript">const x = 1;</code></pre>');
    expect(editor.view.dom.querySelector('.docs-mermaid-wrapper')).toBeNull();
  });

  it('does not add a diagram wrapper for a code block with no language', () => {
    editor = createEditor('<pre><code>plain text</code></pre>');
    expect(editor.view.dom.querySelector('.docs-mermaid-wrapper')).toBeNull();
  });

  it('keeps a single diagram wrapper (not duplicated) as the diagram text is edited', () => {
    editor = createEditor('<pre><code class="language-mermaid">graph TD; A--&gt;B;</code></pre>');
    expect(editor.view.dom.querySelectorAll('.docs-mermaid-wrapper')).toHaveLength(1);

    const codeBlockEnd = editor.state.doc.child(0).nodeSize - 1;
    editor.view.dispatch(editor.state.tr.insertText(' C-->D;', codeBlockEnd));

    expect(editor.state.doc.child(0).textContent).toContain('C-->D;');
    expect(editor.view.dom.querySelectorAll('.docs-mermaid-wrapper')).toHaveLength(1);
  });
});
