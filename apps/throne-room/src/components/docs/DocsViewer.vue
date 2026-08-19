<script setup lang="ts">
/**
 * /docs — git-backed markdown doc viewer/editor.
 *
 * Talks to Cabinet exclusively via the `docs` MCP action group (list/load/save).
 * Explicit save = one commit; there is no auto-save.
 *
 * Editing is WYSIWYG via Tiptap, with the `tiptap-markdown` extension handling
 * bidirectional conversion so the file on disk stays plain markdown.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { Editor, EditorContent } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { DOMParser as PMDOMParser, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { GitRef } from '@minions/mcp-types';
import { callMCPThroneRaw } from '../../api/cabinet';
import { CommentMarker, insertCommentMarkerAt } from './commentMarkerExtension';
import { MermaidDiagram } from './mermaidExtension';
import { DiffHighlight, setDiffBase, setDiffEnabled, collectDiffBlocks, type CurrentBlock } from './diffHighlightExtension';

// tiptap-markdown doesn't ship a `@tiptap/core` Storage augmentation, so its
// `editor.storage.markdown` slot isn't visible on Editor's built-in type.
function getMarkdown(instance: { storage: unknown }): string {
  return (instance.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown();
}

type RepoKind = 'work' | 'private' | 'info';

interface DocsListResult {
  repoKind: RepoKind;
  repo: string;
  branch: string;
  readOnly: boolean;
  files: string[];
  isDirty?: boolean;
}

interface DocsLoadResult {
  repoKind: RepoKind;
  repo: string;
  branch: string;
  path: string;
  readOnly: boolean;
  content: string;
  sessionCommitRef?: GitRef;
}

interface DocsLoadAtRefResult {
  content: string | null;
}

interface DocsSaveResult {
  repoKind: RepoKind;
  repo: string;
  branch: string;
  path: string;
  commitHash: string;
}

type SessionPhase = 'opening' | 'ready' | 'error';
type FilePhase = 'idle' | 'loading' | 'loaded' | 'error';
type SavePhase = 'idle' | 'saving' | 'saved' | 'error';

const route = useRoute();

const repoKind = computed(() => (route.query.repoKind as string | undefined) as RepoKind | undefined);
const repo = computed(() => route.query.repo as string | undefined);
const branch = computed(() => route.query.branch as string | undefined);
const initialPath = computed(() => route.query.path as string | undefined);

const sessionPhase = ref<SessionPhase>('opening');
const sessionError = ref('');
const readOnly = ref(false);
const files = ref<string[]>([]);
const filterQuery = ref('');

const activePath = ref<string | null>(null);
const filePhase = ref<FilePhase>('idle');
const fileError = ref('');
const savedContent = ref('');
const currentMarkdown = ref('');

const savePhase = ref<SavePhase>('idle');
const saveError = ref('');
const lastCommitHash = ref('');

const sessionCommitRef = ref<GitRef | undefined>();
const diffMode = ref(false);
const diffLoading = ref(false);
const diffError = ref('');

const editor = ref<Editor>();

const filteredFiles = computed(() => {
  const q = filterQuery.value.trim().toLowerCase();
  if (!q) return files.value;
  return files.value.filter((f) => f.toLowerCase().includes(q));
});

const isDirty = computed(() => currentMarkdown.value !== savedContent.value);

const repoLabel = computed(() => {
  if (!repoKind.value || !repo.value) return '';
  const kind = repoKind.value === 'work' ? 'work' : repoKind.value === 'private' ? 'private' : 'info';
  return branch.value ? `${kind}/${repo.value} @ ${branch.value}` : `${kind}/${repo.value}`;
});

function fileName(path: string): string {
  return path.split('/').pop() ?? path;
}

function fileDir(path: string): string {
  const parts = path.split('/');
  parts.pop();
  return parts.join('/');
}

async function bootSession(): Promise<void> {
  sessionPhase.value = 'opening';
  sessionError.value = '';

  if (!repoKind.value || (repoKind.value !== 'work' && repoKind.value !== 'private' && repoKind.value !== 'info')) {
    sessionError.value = 'Missing or invalid repoKind in the URL. Expected work, private, or info.';
    sessionPhase.value = 'error';
    return;
  }
  if (!repo.value) {
    sessionError.value = 'Missing repo in the URL.';
    sessionPhase.value = 'error';
    return;
  }
  if (repoKind.value !== 'info' && !branch.value) {
    sessionError.value = 'Missing branch in the URL — required for work and private repos.';
    sessionPhase.value = 'error';
    return;
  }

  try {
    const result = await callMCPThroneRaw<DocsListResult>('docs', {
      action: 'list',
      repoKind: repoKind.value,
      repo: repo.value,
      ...(branch.value ? { branch: branch.value } : {}),
    });
    files.value = result.files;
    readOnly.value = result.readOnly;
    sessionPhase.value = 'ready';

    const openPath = initialPath.value && result.files.includes(initialPath.value) ? initialPath.value : undefined;
    if (openPath) {
      await openFile(openPath);
    }
  } catch (e) {
    sessionError.value = e instanceof Error ? e.message : 'Failed to open the doc session.';
    sessionPhase.value = 'error';
  }
}

async function openFile(path: string): Promise<void> {
  if (filePhase.value === 'loading' && activePath.value === path) return;

  activePath.value = path;
  filePhase.value = 'loading';
  fileError.value = '';
  savePhase.value = 'idle';
  if (editor.value && diffMode.value) setDiffEnabled(editor.value, false);
  diffMode.value = false;
  diffError.value = '';

  try {
    const result = await callMCPThroneRaw<DocsLoadResult>('docs', {
      action: 'load',
      repoKind: repoKind.value,
      repo: repo.value,
      ...(branch.value ? { branch: branch.value } : {}),
      path,
    });
    sessionCommitRef.value = result.sessionCommitRef;
    editor.value?.commands.setContent(result.content);
    editor.value?.setEditable(!readOnly.value);
    // Re-derive from the editor's own serialization (not the raw file bytes) so a
    // formatting round-trip (list markers, heading style, ...) doesn't read as "dirty".
    const canonical = editor.value ? getMarkdown(editor.value) : result.content;
    savedContent.value = canonical;
    currentMarkdown.value = canonical;
    filePhase.value = 'loaded';
  } catch (e) {
    fileError.value = e instanceof Error ? e.message : `Failed to open ${path}.`;
    filePhase.value = 'error';
  }
}

/** Parses markdown source into the same block texts (+ their actual nodes,
 * needed to revert a block's real formatting, not just its plain text)
 * DiffHighlight derives from the live doc, using the LIVE editor's own
 * schema and markdown parser — not a separate throwaway Editor instance,
 * which would construct its own distinct schema. Nodes are only valid
 * within the schema that minted their NodeType; inserting a foreign-schema
 * node into the live doc via a revert transaction silently drops it instead
 * of inserting it (this was a real bug, caught by testing revert in the
 * actual browser — the schema mismatch didn't show up in unit tests that
 * happened to build both sides' nodes from the same editor instance). */
function parseMarkdownBlocks(editor: Editor, markdown: string): { texts: string[]; nodes: ProseMirrorNode[] } {
  const html = (editor.storage as unknown as { markdown: { parser: { parse(content: string): string } } }).markdown.parser.parse(markdown);
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  const doc = PMDOMParser.fromSchema(editor.schema).parse(wrapper);
  const blocks: CurrentBlock[] = [];
  collectDiffBlocks(doc, 0, blocks);
  return { texts: blocks.map((b) => b.text), nodes: blocks.map((b) => b.node) };
}

async function toggleDiff(): Promise<void> {
  if (!editor.value || !activePath.value || readOnly.value) return;

  if (diffMode.value) {
    setDiffEnabled(editor.value, false);
    diffMode.value = false;
    return;
  }

  if (!sessionCommitRef.value) {
    diffError.value = 'No base commit recorded for this session.';
    return;
  }

  diffLoading.value = true;
  diffError.value = '';
  try {
    const result = await callMCPThroneRaw<DocsLoadAtRefResult>('docs', {
      action: 'load',
      repoKind: repoKind.value,
      repo: repo.value,
      ...(branch.value ? { branch: branch.value } : {}),
      path: activePath.value,
      ref: sessionCommitRef.value,
    });
    const activeEditor = editor.value;
    if (!activeEditor) return;
    const { texts: baseBlocks, nodes: baseNodes } = result.content === null ? { texts: [], nodes: [] } : parseMarkdownBlocks(activeEditor, result.content);
    setDiffBase(activeEditor, baseBlocks, baseNodes);
    setDiffEnabled(activeEditor, true);
    diffMode.value = true;
  } catch (e) {
    diffError.value = e instanceof Error ? e.message : 'Failed to load the diff base.';
  } finally {
    diffLoading.value = false;
  }
}

async function saveFile(): Promise<void> {
  if (readOnly.value || !activePath.value || savePhase.value === 'saving' || !editor.value) return;

  savePhase.value = 'saving';
  saveError.value = '';

  try {
    const content = getMarkdown(editor.value);
    const result = await callMCPThroneRaw<DocsSaveResult>('docs', {
      action: 'save',
      repoKind: repoKind.value,
      repo: repo.value,
      branch: branch.value,
      path: activePath.value,
      content,
    });
    savedContent.value = content;
    currentMarkdown.value = content;
    lastCommitHash.value = result.commitHash;
    savePhase.value = 'saved';
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : 'Save failed.';
    savePhase.value = 'error';
  }
}

function addCommentAtCursor(): void {
  if (!editor.value || readOnly.value) return;
  const { view } = editor.value;
  const { $from } = view.state.selection;
  const insertPos = $from.after($from.depth);
  insertCommentMarkerAt(view, insertPos);
}

// Ticks up on every selection/doc change so isActive()-based toolbar state
// (a plain, non-reactive Tiptap method call) re-evaluates in the template.
const toolbarTick = ref(0);

interface ToolbarAction {
  label: string;
  title: string;
  isActive: () => boolean;
  run: () => void;
}

const toolbarActions = computed<ToolbarAction[]>(() => {
  void toolbarTick.value;
  const e = editor.value;
  if (!e) return [];
  return [
    { label: 'B', title: 'Bold', isActive: () => e.isActive('bold'), run: () => e.chain().focus().toggleBold().run() },
    {
      label: 'I',
      title: 'Italic',
      isActive: () => e.isActive('italic'),
      run: () => e.chain().focus().toggleItalic().run(),
    },
    {
      label: 'S',
      title: 'Strikethrough',
      isActive: () => e.isActive('strike'),
      run: () => e.chain().focus().toggleStrike().run(),
    },
    {
      label: 'H1',
      title: 'Heading 1',
      isActive: () => e.isActive('heading', { level: 1 }),
      run: () => e.chain().focus().toggleHeading({ level: 1 }).run(),
    },
    {
      label: 'H2',
      title: 'Heading 2',
      isActive: () => e.isActive('heading', { level: 2 }),
      run: () => e.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      label: '•',
      title: 'Bullet list',
      isActive: () => e.isActive('bulletList'),
      run: () => e.chain().focus().toggleBulletList().run(),
    },
    {
      label: '1.',
      title: 'Numbered list',
      isActive: () => e.isActive('orderedList'),
      run: () => e.chain().focus().toggleOrderedList().run(),
    },
    {
      label: '"',
      title: 'Quote',
      isActive: () => e.isActive('blockquote'),
      run: () => e.chain().focus().toggleBlockquote().run(),
    },
    {
      label: '</>',
      title: 'Code block',
      isActive: () => e.isActive('codeBlock'),
      run: () => e.chain().focus().toggleCodeBlock().run(),
    },
    {
      label: '—',
      title: 'Horizontal rule',
      isActive: () => false,
      run: () => e.chain().focus().setHorizontalRule().run(),
    },
  ];
});

onMounted(() => {
  editor.value = new Editor({
    extensions: [StarterKit, Markdown, CommentMarker, MermaidDiagram, DiffHighlight],
    editable: !readOnly.value,
    onUpdate: ({ editor: instance }) => {
      currentMarkdown.value = getMarkdown(instance);
    },
    onTransaction: () => {
      toolbarTick.value++;
    },
  });
  bootSession();
});

onBeforeUnmount(() => {
  editor.value?.destroy();
});

watch(readOnly, (value) => {
  editor.value?.setEditable(!value);
});
</script>

<template>
  <div class="docs-viewer">
    <!-- ── Opening state ─────────────────────────────────────────────── -->
    <div v-if="sessionPhase === 'opening'" class="docs-status-screen">
      <div class="docs-status-mark" aria-hidden="true"></div>
      <p class="docs-status-title">Opening your workspace…</p>
      <p class="docs-status-sub">Setting up the document session — this can take a few seconds on first open.</p>
    </div>

    <!-- ── Error state ───────────────────────────────────────────────── -->
    <div v-else-if="sessionPhase === 'error'" class="docs-status-screen">
      <p class="docs-status-title docs-status-title--error">Could not open this session</p>
      <p class="docs-status-sub">{{ sessionError }}</p>
    </div>

    <!-- ── Ready ─────────────────────────────────────────────────────── -->
    <template v-else>
      <header class="docs-header">
        <span class="docs-header__mark">DOCS</span>
        <span class="docs-header__repo">{{ repoLabel }}</span>
        <span v-if="readOnly" class="docs-badge docs-badge--readonly">read-only</span>
        <span v-else class="docs-badge docs-badge--editable">editable</span>
      </header>

      <div class="docs-body">
        <aside class="docs-sidebar">
          <input
            v-model="filterQuery"
            class="docs-filter"
            type="text"
            placeholder="Filter files…"
            autocomplete="off"
          />
          <div class="docs-file-list">
            <p v-if="filteredFiles.length === 0" class="docs-file-empty">
              {{ files.length === 0 ? 'No markdown files found.' : 'No files match.' }}
            </p>
            <button
              v-for="path in filteredFiles"
              :key="path"
              class="docs-file"
              :class="{ 'docs-file--active': path === activePath }"
              :title="path"
              @click="openFile(path)"
            >
              <span class="docs-file__name">{{ fileName(path) }}</span>
              <span v-if="fileDir(path)" class="docs-file__dir">{{ fileDir(path) }}</span>
            </button>
          </div>
        </aside>

        <main class="docs-main">
          <div v-if="!activePath" class="docs-empty">
            <p class="docs-empty__title">No document open</p>
            <p class="docs-empty__sub">Choose a file from the list to start reading.</p>
          </div>

          <div v-else-if="filePhase === 'loading'" class="docs-empty">
            <p class="docs-empty__title">Loading {{ fileName(activePath) }}…</p>
          </div>

          <div v-else-if="filePhase === 'error'" class="docs-empty">
            <p class="docs-empty__title docs-empty__title--error">Could not open this file</p>
            <p class="docs-empty__sub">{{ fileError }}</p>
          </div>

          <template v-else-if="filePhase === 'loaded'">
            <div class="docs-editor-bar">
              <span class="docs-editor-path">{{ activePath }}</span>
              <span v-if="isDirty && !readOnly" class="docs-dirty-dot" title="Unsaved changes">●</span>

              <div class="docs-editor-actions">
                <transition name="docs-stamp">
                  <span v-if="savePhase === 'saved'" class="docs-stamp">
                    saved as <code>{{ lastCommitHash.slice(0, 7) }}</code>
                  </span>
                </transition>
                <span v-if="savePhase === 'error'" class="docs-save-error">{{ saveError }}</span>
                <span v-if="diffError" class="docs-save-error">{{ diffError }}</span>
                <button
                  v-if="!readOnly"
                  class="docs-diff-btn"
                  :class="{ 'docs-diff-btn--active': diffMode }"
                  :disabled="diffLoading"
                  @click="toggleDiff"
                >
                  {{ diffLoading ? 'Loading diff…' : diffMode ? 'Diff: on' : 'Diff' }}
                </button>
                <button v-if="!readOnly" class="docs-comment-btn" @click="addCommentAtCursor">Add comment</button>
                <button
                  v-if="!readOnly"
                  class="docs-save-btn"
                  :disabled="!isDirty || savePhase === 'saving'"
                  @click="saveFile"
                >
                  {{ savePhase === 'saving' ? 'Saving…' : 'Save' }}
                </button>
              </div>
            </div>

            <div v-if="!readOnly" class="docs-toolbar">
              <button
                v-for="action in toolbarActions"
                :key="action.title"
                type="button"
                class="docs-toolbar-btn"
                :class="{ 'docs-toolbar-btn--active': action.isActive() }"
                :title="action.title"
                @click="action.run()"
              >
                {{ action.label }}
              </button>
            </div>

            <EditorContent
              class="docs-editor"
              :class="{ 'docs-editor--readonly': readOnly }"
              :editor="editor"
            />
          </template>
        </main>
      </div>
    </template>
  </div>
</template>

<style scoped>
.docs-viewer {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #0b0d12;
  color: #e6e8ec;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  overflow: hidden;
}

/* ── Opening / session-error state ───────────────────────────────────── */

.docs-status-screen {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  text-align: center;
  padding: 24px;
}

.docs-status-mark {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 2px solid #1f2430;
  border-top-color: #4ade80;
  animation: docs-spin 0.9s linear infinite;
}

@keyframes docs-spin {
  to { transform: rotate(360deg); }
}

.docs-status-title {
  font-family: Georgia, 'Times New Roman', serif;
  font-style: italic;
  font-size: 20px;
  color: #e6e8ec;
  margin: 0;
}

.docs-status-title--error {
  color: #f87171;
  font-style: normal;
  font-weight: 700;
}

.docs-status-sub {
  font-size: 13px;
  color: #7c8394;
  max-width: 360px;
  margin: 0;
  line-height: 1.5;
}

/* ── Header ───────────────────────────────────────────────────────────── */

.docs-header {
  flex-shrink: 0;
  height: 40px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px;
  background: #12151c;
  border-bottom: 1px solid #1f2430;
}

.docs-header__mark {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #4ade80;
}

.docs-header__repo {
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 12px;
  color: #9aa1b1;
}

.docs-badge {
  margin-left: auto;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 3px 9px;
  border-radius: 3px;
}

.docs-badge--readonly {
  color: #d4a017;
  border: 1px solid rgba(212, 160, 23, 0.35);
  background: rgba(212, 160, 23, 0.08);
}

.docs-badge--editable {
  color: #4ade80;
  border: 1px solid rgba(74, 222, 128, 0.3);
  background: rgba(74, 222, 128, 0.06);
}

/* ── Body layout ──────────────────────────────────────────────────────── */

.docs-body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.docs-sidebar {
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: #0e1017;
  border-right: 1px solid #1f2430;
  min-height: 0;
}

.docs-filter {
  margin: 10px 10px 6px;
  padding: 6px 9px;
  background: #171b24;
  border: 1px solid #262b38;
  border-radius: 4px;
  color: #e6e8ec;
  font-size: 12px;
}

.docs-filter:focus {
  outline: none;
  border-color: #4ade80;
}

.docs-file-list {
  flex: 1;
  overflow-y: auto;
  padding: 2px 6px 10px;
}

.docs-file-empty {
  padding: 10px;
  font-size: 12px;
  color: #565d6c;
}

.docs-file {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  padding: 7px 10px;
  margin: 1px 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #b7bcc7;
  cursor: pointer;
  text-align: left;
}

.docs-file:hover {
  background: #171b24;
}

.docs-file--active {
  background: rgba(74, 222, 128, 0.1);
  color: #e6e8ec;
}

.docs-file__name {
  font-size: 12.5px;
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
}

.docs-file__dir {
  font-size: 10.5px;
  color: #565d6c;
}

.docs-file--active .docs-file__dir {
  color: #6f9c81;
}

/* ── Main / editor ────────────────────────────────────────────────────── */

.docs-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.docs-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  text-align: center;
}

.docs-empty__title {
  font-family: Georgia, 'Times New Roman', serif;
  font-style: italic;
  font-size: 17px;
  color: #7c8394;
  margin: 0;
}

.docs-empty__title--error {
  color: #f87171;
  font-style: normal;
  font-weight: 700;
}

.docs-empty__sub {
  font-size: 12.5px;
  color: #565d6c;
  max-width: 320px;
  margin: 0;
}

.docs-editor-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: #12151c;
  border-bottom: 1px solid #1f2430;
}

.docs-editor-path {
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 12px;
  color: #9aa1b1;
}

.docs-dirty-dot {
  color: #d4a017;
  font-size: 10px;
}

.docs-editor-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}

.docs-stamp {
  font-size: 11.5px;
  color: #4ade80;
  border: 1px solid rgba(74, 222, 128, 0.4);
  background: rgba(74, 222, 128, 0.1);
  border-radius: 999px;
  padding: 3px 10px;
}

.docs-stamp code {
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
}

.docs-stamp-enter-active {
  transition: transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.2s ease;
}

.docs-stamp-enter-from {
  opacity: 0;
  transform: scale(0.6);
}

.docs-stamp-leave-active {
  transition: opacity 0.5s ease 1.4s;
}

.docs-stamp-leave-to {
  opacity: 0;
}

.docs-save-error {
  font-size: 11.5px;
  color: #f87171;
}

.docs-save-btn {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: #0b0d12;
  background: #4ade80;
  border: none;
  border-radius: 4px;
  padding: 6px 16px;
  cursor: pointer;
}

.docs-save-btn:hover:not(:disabled) {
  background: #6ee7a3;
}

.docs-save-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.docs-diff-btn {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: #e6e8ec;
  background: transparent;
  border: 1px solid #2a3040;
  border-radius: 4px;
  padding: 6px 12px;
  cursor: pointer;
}

.docs-diff-btn:hover:not(:disabled) {
  border-color: #4b5568;
}

.docs-diff-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.docs-diff-btn--active {
  color: #3b82f6;
  border-color: rgba(59, 130, 246, 0.5);
  background: rgba(59, 130, 246, 0.1);
}

.docs-comment-btn {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: #e6e8ec;
  background: transparent;
  border: 1px solid #2a3040;
  border-radius: 4px;
  padding: 6px 12px;
  cursor: pointer;
}

.docs-comment-btn:hover {
  border-color: #4b5568;
}

/* ── Comment markers (@tag: text, place-anchored) ────────────────────────
   Colorblind-friendly: blue for @ai, orange for everything else, plus the
   "@tag" text badge itself as a non-color cue so tag identity never depends
   on color alone. */

.docs-editor :deep(.docs-comment-marker) {
  position: relative;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.4em;
  margin: 0.4em 0;
  padding: 0.5em 0.75em;
  border-left: 3px solid #f59e0b;
  border-radius: 3px;
  background: rgba(245, 158, 11, 0.08);
}

.docs-editor :deep(.docs-comment-marker[data-comment-tag='ai']) {
  border-left-color: #3b82f6;
  background: rgba(59, 130, 246, 0.08);
}

.docs-editor :deep(.docs-comment-marker__tag) {
  flex-shrink: 0;
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 11px;
  font-weight: 700;
  color: #935700;
  background: rgba(245, 158, 11, 0.18);
  border-radius: 3px;
  padding: 1px 6px;
}

.docs-editor :deep(.docs-comment-marker[data-comment-tag='ai']) .docs-comment-marker__tag {
  color: #1d4ed8;
  background: rgba(59, 130, 246, 0.18);
}

.docs-editor :deep(.docs-comment-marker__controls) {
  margin-left: auto;
  display: flex;
  gap: 6px;
}

.docs-editor :deep(.docs-comment-marker__control) {
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  font-size: 10.5px;
  font-weight: 600;
  color: #4a453d;
  background: rgba(0, 0, 0, 0.06);
  border: 1px solid rgba(0, 0, 0, 0.15);
  border-radius: 3px;
  padding: 2px 8px;
  cursor: pointer;
}

.docs-editor :deep(.docs-comment-marker__control:hover) {
  background: rgba(0, 0, 0, 0.12);
}

/* ── Diff overlay (colorblind-friendly: blue additions, orange deletions,
   plus +/- prefixes and underline/strikethrough so identity never depends
   on color alone) ─────────────────────────────────────────────────────── */

.docs-editor :deep(.docs-diff-added) {
  color: #1d4ed8;
  background: rgba(59, 130, 246, 0.12);
  text-decoration: underline;
  text-decoration-color: #3b82f6;
}

.docs-editor :deep(.docs-diff-added)::before {
  content: '+';
  color: #1d4ed8;
  font-weight: 700;
}

/* A whole added BLOCK gets the same visual weight as a whole removed block
   (its own highlighted, bordered row) instead of just an inline color
   change — this is real document content (not a widget), so list numbering
   etc. still works normally; the box just wraps that real node. */
.docs-editor :deep(.docs-diff-added-block) {
  display: block;
  color: #1d4ed8;
  background: rgba(59, 130, 246, 0.12);
  border-left: 3px solid #3b82f6;
  border-radius: 3px;
  padding: 0.5em 0.75em;
  margin: 0.5em 0;
}

.docs-editor :deep(.docs-diff-added-block)::before {
  content: '+ ';
  font-weight: 700;
}

.docs-editor :deep(.docs-diff-removed) {
  color: #935700;
  background: rgba(245, 158, 11, 0.12);
  text-decoration: line-through;
  text-decoration-color: #f59e0b;
  cursor: default;
}

.docs-editor :deep(.docs-diff-removed--word) {
  display: inline;
}

.docs-editor :deep(.docs-diff-removed--block) {
  display: flex;
  align-items: baseline;
  gap: 0.6em;
  margin: 0.5em 0;
  padding: 0.5em 0.75em;
  border-left: 3px solid #f59e0b;
  border-radius: 3px;
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 15px;
  line-height: 1.7;
}

.docs-editor :deep(.docs-diff-removed--block) > span {
  white-space: pre-wrap;
  flex: 1;
}

/* ── Revert controls — a small "undo" button attached to a diff hunk ────── */

.docs-editor :deep(.docs-diff-revert-btn) {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.4em;
  height: 1.4em;
  font-size: 13px;
  line-height: 1;
  color: #4a453d;
  background: rgba(0, 0, 0, 0.06);
  border: 1px solid rgba(0, 0, 0, 0.15);
  border-radius: 3px;
  cursor: pointer;
}

.docs-editor :deep(.docs-diff-revert-btn):hover {
  background: rgba(0, 0, 0, 0.12);
}

/* ── Mermaid diagrams ─────────────────────────────────────────────────────
   Render at natural size (never shrunk to fit) and let the wrapper scroll in
   both directions — large diagrams stay readable, at the cost of panning. */

.docs-editor :deep(.docs-mermaid-wrapper) {
  margin: 0.75em 0;
  padding: 12px;
  overflow: auto;
  max-width: 100%;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 4px;
  background: #ffffff;
}

.docs-editor :deep(.docs-mermaid-wrapper svg) {
  display: block;
}

.docs-editor :deep(.docs-mermaid-wrapper--error) {
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 12px;
  color: #b91c1c;
  background: rgba(185, 28, 28, 0.06);
  white-space: pre-wrap;
}

.docs-toolbar {
  flex-shrink: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 14px;
  background: #12151c;
  border-bottom: 1px solid #1f2430;
}

.docs-toolbar-btn {
  min-width: 26px;
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 12px;
  font-weight: 700;
  color: #b7bcc7;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 4px 8px;
  cursor: pointer;
}

.docs-toolbar-btn:hover {
  background: #1f2430;
  color: #e6e8ec;
}

.docs-toolbar-btn--active {
  color: #4ade80;
  border-color: rgba(74, 222, 128, 0.4);
  background: rgba(74, 222, 128, 0.1);
}

.docs-editor {
  flex: 1;
  width: 100%;
  min-height: 0;
  overflow-y: auto;
  box-sizing: border-box;
  background: #f5f1e8;
  color: #262220;
}

.docs-editor--readonly {
  background: #efece3;
  color: #4a453d;
  cursor: default;
}

.docs-editor :deep(.ProseMirror) {
  min-height: 100%;
  box-sizing: border-box;
  padding: 22px 26px;
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 15px;
  line-height: 1.7;
  outline: none;
}

.docs-editor :deep(.ProseMirror) > * + * {
  margin-top: 0.75em;
}

.docs-editor :deep(.ProseMirror) code {
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 0.9em;
  background: rgba(0, 0, 0, 0.06);
  border-radius: 3px;
  padding: 0.1em 0.3em;
}

.docs-editor :deep(.ProseMirror) pre {
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 13px;
  background: rgba(0, 0, 0, 0.06);
  border-radius: 4px;
  padding: 12px 14px;
  overflow-x: auto;
}

.docs-editor :deep(.ProseMirror) pre code {
  background: none;
  padding: 0;
}

.docs-editor :deep(.ProseMirror) blockquote {
  border-left: 3px solid rgba(0, 0, 0, 0.15);
  margin: 0;
  padding-left: 1em;
  color: #5a544a;
}

/* ── Headings — distinct size/weight per level, sans-serif so they read as
   structure rather than more body text ────────────────────────────────── */

.docs-editor :deep(.ProseMirror) h1,
.docs-editor :deep(.ProseMirror) h2,
.docs-editor :deep(.ProseMirror) h3,
.docs-editor :deep(.ProseMirror) h4,
.docs-editor :deep(.ProseMirror) h5,
.docs-editor :deep(.ProseMirror) h6 {
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  font-weight: 700;
  line-height: 1.3;
  color: #1a1613;
}

.docs-editor :deep(.ProseMirror) h1 { font-size: 1.9em; margin-top: 1.1em; border-bottom: 1px solid rgba(0, 0, 0, 0.1); padding-bottom: 0.2em; }
.docs-editor :deep(.ProseMirror) h2 { font-size: 1.5em; margin-top: 1em; border-bottom: 1px solid rgba(0, 0, 0, 0.08); padding-bottom: 0.15em; }
.docs-editor :deep(.ProseMirror) h3 { font-size: 1.25em; margin-top: 0.9em; }
.docs-editor :deep(.ProseMirror) h4 { font-size: 1.1em; margin-top: 0.8em; }
.docs-editor :deep(.ProseMirror) h5,
.docs-editor :deep(.ProseMirror) h6 {
  font-size: 1em;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #5a544a;
}

.docs-editor :deep(.ProseMirror) h1:first-child,
.docs-editor :deep(.ProseMirror) h2:first-child {
  margin-top: 0;
}

/* ── Lists — visible markers, proper indent, tighter spacing between items
   than between paragraphs so a list still reads as one unit ────────────── */

.docs-editor :deep(.ProseMirror) ul,
.docs-editor :deep(.ProseMirror) ol {
  padding-left: 1.6em;
  margin: 0.75em 0;
}

.docs-editor :deep(.ProseMirror) ul {
  list-style: disc;
}

.docs-editor :deep(.ProseMirror) ul ul {
  list-style: circle;
}

.docs-editor :deep(.ProseMirror) ol {
  list-style: decimal;
}

.docs-editor :deep(.ProseMirror) li {
  margin: 0.3em 0;
  padding-left: 0.2em;
}

.docs-editor :deep(.ProseMirror) li > * + * {
  margin-top: 0.4em;
}

.docs-editor :deep(.ProseMirror) li p {
  margin: 0;
}

/* ── Inline emphasis, links, horizontal rule ─────────────────────────────── */

.docs-editor :deep(.ProseMirror) strong {
  font-weight: 700;
}

.docs-editor :deep(.ProseMirror) em {
  font-style: italic;
}

.docs-editor :deep(.ProseMirror) a {
  color: #1d4ed8;
  text-decoration: underline;
  text-decoration-color: rgba(29, 78, 216, 0.4);
}

.docs-editor :deep(.ProseMirror) hr {
  border: none;
  border-top: 2px solid rgba(0, 0, 0, 0.12);
  margin: 1.5em 0;
}
</style>
