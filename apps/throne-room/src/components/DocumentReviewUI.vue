<template>
  <div class="review-ui">
    <div class="review-purpose">{{ reviewContext.purpose }}</div>

    <!-- Document tabs + search -->
    <div class="doc-nav">
      <div class="doc-tabs">
        <button
          v-for="path in openPaths"
          :key="path"
          :class="['doc-tab', { active: activeDocPath === path }]"
          @click="switchDoc(path)"
          :title="path"
        >
          {{ docName(path) }}
          <span v-if="isModified(path)" class="modified-dot" title="Unsaved changes">●</span>
        </button>
      </div>

      <div class="doc-search-wrap">
        <input
          v-model="searchQuery"
          @input="onSearchInput"
          @blur="clearSearchDelayed"
          placeholder="+ Add document…"
          class="doc-search-input"
          autocomplete="off"
        />
        <div v-if="searchResults.length > 0" class="search-dropdown">
          <button
            v-for="match in searchResults"
            :key="match.path"
            class="search-match"
            @mousedown.prevent="addDocument(match)"
          >
            <span class="match-name">{{ match.name }}</span>
            <span class="match-path">{{ match.path }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Editor -->
    <div class="editor-wrap" v-if="activeDocPath">
      <div class="editor-bar">
        <span class="editor-path">{{ activeDocPath }}</span>
        <span v-if="saving" class="save-status saving">Saving…</span>
        <span v-else-if="justSaved" class="save-status saved">Saved</span>
      </div>
      <textarea
        class="doc-editor"
        :value="docContents[activeDocPath] ?? ''"
        @input="handleEdit"
        :disabled="submitting"
        spellcheck="true"
        wrap="soft"
      ></textarea>
    </div>
    <div v-else class="no-doc">No document selected.</div>

    <!-- @ai: guide -->
    <div class="ai-guide">
      Add <code>**@ai:** your instruction</code> anywhere to leave a comment for the AI.
    </div>

    <div v-if="loadError" class="review-error">{{ loadError }}</div>

    <div class="review-actions">
      <button
        class="go-btn"
        @click="handleSubmit"
        :disabled="submitting || saving"
      >
        {{ submitting ? 'Submitting…' : 'AI, go!' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { callMCPThrone, callMCPThroneRaw } from '../api/cabinet';
import type { AskResult } from '@minions/mcp-types';
import type { Question } from '../types/question';
import type { ReviewParams } from '@minions/mcp-types';

// The `review` MCP tool supports additional actions (load/save/search) beyond the
// `start` action modeled in ReviewParams/ReviewResult. These local types describe
// the actual shapes exchanged for those actions.
interface ReviewLoadResult {
  content: string;
}

interface ReviewSearchResult {
  matches: Array<{ path: string; name: string }>;
}

export interface ReviewContext {
  __type: 'review';
  purpose: string;
  openDocuments: Array<{ path: string }>;
  scope: string;
}

const props = defineProps<{
  question: Question;
  reviewContext: ReviewContext;
}>();

const emit = defineEmits<{
  answered: [questionId: string];
}>();

const openPaths = ref<string[]>([]);
const activeDocPath = ref('');
const docContents = ref<Record<string, string>>({});
const savedContents = ref<Record<string, string>>({});
const saving = ref(false);
const justSaved = ref(false);
const submitting = ref(false);
const loadError = ref<string | null>(null);
const searchQuery = ref('');
const searchResults = ref<Array<{ path: string; name: string }>>([]);

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let savedFlashTimer: ReturnType<typeof setTimeout> | null = null;

// ── Init ──────────────────────────────────────────────────────────────────────

onMounted(async () => {
  const paths = props.reviewContext.openDocuments.map((d) => d.path);
  openPaths.value = paths;
  activeDocPath.value = paths[0] ?? '';
  await Promise.all(paths.map(loadDoc));
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function docName(path: string): string {
  return path.split('/').pop()?.replace(/\.md$/, '') ?? path;
}

function isModified(path: string): boolean {
  return (docContents.value[path] ?? '') !== (savedContents.value[path] ?? '');
}

async function loadDoc(path: string): Promise<void> {
  try {
    const result = await callMCPThrone('review', {
      action: 'load',
      wingName: props.question.wingName,
      path,
    } as unknown as ReviewParams) as unknown as ReviewLoadResult;
    docContents.value[path] = result.content;
    savedContents.value[path] = result.content;
  } catch (e) {
    loadError.value = `Failed to load ${path}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function saveDoc(path: string): Promise<void> {
  if (!isModified(path)) return;
  saving.value = true;
  try {
    await callMCPThrone('review', {
      action: 'save',
      wingName: props.question.wingName,
      path,
      content: docContents.value[path] ?? '',
    } as unknown as ReviewParams);
    savedContents.value[path] = docContents.value[path] ?? '';
    justSaved.value = true;
    if (savedFlashTimer) clearTimeout(savedFlashTimer);
    savedFlashTimer = setTimeout(() => { justSaved.value = false; }, 2000);
  } catch (e) {
    loadError.value = `Save failed: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    saving.value = false;
  }
}

// ── Event handlers ────────────────────────────────────────────────────────────

function switchDoc(path: string): void {
  activeDocPath.value = path;
}

function handleEdit(event: Event): void {
  const ta = event.target as HTMLTextAreaElement;
  docContents.value[activeDocPath.value] = ta.value;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveDoc(activeDocPath.value), 800);
}

function onSearchInput(): void {
  if (searchTimer) clearTimeout(searchTimer);
  const q = searchQuery.value.trim();
  if (!q) {
    searchResults.value = [];
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const result = await callMCPThrone('review', {
        action: 'search',
        wingName: props.question.wingName,
        scope: props.reviewContext.scope,
        query: q,
      } as unknown as ReviewParams) as unknown as ReviewSearchResult;
      searchResults.value = result.matches.filter((m) => !openPaths.value.includes(m.path));
    } catch {
      searchResults.value = [];
    }
  }, 300);
}

function clearSearchDelayed(): void {
  setTimeout(() => {
    searchResults.value = [];
    searchQuery.value = '';
  }, 200);
}

async function addDocument(doc: { path: string; name: string }): Promise<void> {
  if (!openPaths.value.includes(doc.path)) {
    openPaths.value.push(doc.path);
    await loadDoc(doc.path);
  }
  activeDocPath.value = doc.path;
  searchQuery.value = '';
  searchResults.value = [];
}

async function handleSubmit(): Promise<void> {
  // Flush any pending auto-save
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  for (const path of openPaths.value) {
    if (isModified(path)) await saveDoc(path);
  }

  submitting.value = true;
  loadError.value = null;
  try {
    await callMCPThroneRaw<AskResult>('ask', {
      action: 'answer',
      questionId: props.question.id,
      answer: 'go',
    });
    emit('answered', props.question.id);
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Failed to submit';
    submitting.value = false;
  }
}
</script>

<style scoped>
.review-ui {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
}

.review-purpose {
  font-size: 13px;
  color: #555;
  font-style: italic;
  padding: 0 4px;
}

/* ── Tabs + Search ────────────────────────────────────────────────────── */

.doc-nav {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.doc-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  flex: 1;
}

.doc-tab {
  padding: 5px 12px;
  border: 1px solid #ccc;
  border-radius: 4px 4px 0 0;
  background: #f5f5f5;
  color: #333;
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 4px;
}

.doc-tab.active {
  background: white;
  border-bottom-color: white;
  font-weight: 600;
  color: #1976d2;
}

.doc-tab:hover:not(.active) {
  background: #e8e8e8;
}

.modified-dot {
  color: #e67700;
  font-size: 11px;
}

.doc-search-wrap {
  position: relative;
}

.doc-search-input {
  padding: 5px 10px;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 13px;
  width: 180px;
}

.doc-search-input:focus {
  outline: none;
  border-color: #1976d2;
}

.search-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  min-width: 280px;
  background: white;
  border: 1px solid #ccc;
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0,0,0,.12);
  z-index: 100;
  max-height: 200px;
  overflow-y: auto;
}

.search-match {
  display: flex;
  flex-direction: column;
  padding: 8px 12px;
  cursor: pointer;
  text-align: left;
  width: 100%;
  border: none;
  background: none;
}

.search-match:hover {
  background: #f0f7ff;
}

.match-name {
  font-weight: 600;
  font-size: 13px;
  color: #1976d2;
}

.match-path {
  font-size: 11px;
  color: #888;
  font-family: monospace;
}

/* ── Editor ───────────────────────────────────────────────────────────── */

.editor-wrap {
  display: flex;
  flex-direction: column;
  flex: 1;
  border: 1px solid #ddd;
  border-radius: 4px;
  overflow: hidden;
  min-height: 0;
}

.editor-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px;
  background: #f8f8f8;
  border-bottom: 1px solid #ddd;
  font-size: 12px;
}

.editor-path {
  font-family: monospace;
  color: #555;
}

.save-status {
  font-size: 11px;
}

.save-status.saving { color: #999; }
.save-status.saved  { color: #2e7d32; }

.doc-editor {
  flex: 1;
  width: 100%;
  resize: none;
  border: none;
  padding: 12px;
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 13px;
  line-height: 1.6;
  box-sizing: border-box;
  background: #fafafa;
  color: #222;
}

.doc-editor:focus {
  outline: none;
  background: white;
}

.doc-editor:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.no-doc {
  text-align: center;
  color: #999;
  padding: 24px;
}

/* ── Guide + Actions ──────────────────────────────────────────────────── */

.ai-guide {
  font-size: 12px;
  color: #666;
  background: #fff9e6;
  border: 1px solid #ffe082;
  border-radius: 4px;
  padding: 6px 10px;
}

.ai-guide code {
  background: #fff3cd;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12px;
  color: #854d0e;
}

.review-error {
  padding: 10px;
  background: #fee;
  border: 1px solid #fcc;
  border-radius: 4px;
  color: #c00;
  font-size: 13px;
}

.review-actions {
  display: flex;
  justify-content: flex-end;
}

.go-btn {
  padding: 10px 28px;
  background: #1976d2;
  color: white;
  border: none;
  border-radius: 4px;
  font-weight: 700;
  font-size: 15px;
  cursor: pointer;
  letter-spacing: 0.3px;
}

.go-btn:hover:not(:disabled) {
  background: #1565c0;
}

.go-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
