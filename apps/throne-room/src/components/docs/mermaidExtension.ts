import { Extension } from '@tiptap/vue-3';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

// mermaid (plus its diagram-layout deps) is only needed for docs that actually
// contain a ```mermaid block, so it's loaded on demand rather than bundled
// into every DocsViewer page load.
let mermaidPromise: ReturnType<typeof loadMermaid> | undefined;
async function loadMermaid() {
  const mod = (await import('mermaid')).default;
  mod.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict' });
  return mod;
}
function ensureInitialized() {
  if (!mermaidPromise) mermaidPromise = loadMermaid();
  return mermaidPromise;
}

let renderSeq = 0;

function buildDiagram(code: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'docs-mermaid-wrapper';
  wrapper.contentEditable = 'false';

  const id = `docs-mermaid-${renderSeq++}`;
  ensureInitialized()
    .then((mermaid) => mermaid.render(id, code))
    .then(({ svg }) => {
      wrapper.innerHTML = svg;
      // Mermaid emits width="100%" plus a max-width cap that shrinks large
      // diagrams to fit the container. An SVG with only a viewBox (no
      // explicit width/height) still stretches to fill its container in most
      // browsers, so set width/height to the viewBox's own pixel dimensions —
      // that's the diagram's true natural size. The wrapper scrolls instead
      // of shrinking it to fit.
      const svgEl = wrapper.querySelector('svg');
      const viewBox = svgEl?.viewBox.baseVal;
      if (svgEl && viewBox && viewBox.width > 0 && viewBox.height > 0) {
        svgEl.setAttribute('width', String(viewBox.width));
        svgEl.setAttribute('height', String(viewBox.height));
      }
      svgEl?.style.removeProperty('max-width');
    })
    .catch((error: unknown) => {
      wrapper.classList.add('docs-mermaid-wrapper--error');
      wrapper.textContent = `Mermaid diagram error: ${error instanceof Error ? error.message : String(error)}`;
    });

  return wrapper;
}

function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

function buildDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock' || node.attrs['language'] !== 'mermaid') return;

    const to = pos + node.nodeSize;
    const code = node.textContent;
    decorations.push(
      Decoration.widget(to, () => buildDiagram(code), {
        side: 1,
        key: `mermaid-${pos}-${hashText(code)}`,
      }),
    );
  });

  return DecorationSet.create(doc, decorations);
}

export const MermaidDiagram = Extension.create({
  name: 'mermaidDiagram',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('mermaidDiagram'),
        props: {
          decorations(state) {
            return buildDecorations(state.doc);
          },
        },
      }),
    ];
  },
});
