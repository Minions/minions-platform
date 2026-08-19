<template>
  <div class="question-detail-overlay">
    <div :class="['question-detail', { 'question-detail--review': reviewContext, 'question-detail--variants': isVariantsContent }]">
      <div class="detail-header">
        <h3>Answer Question</h3>
        <button @click="$emit('close')" class="close-btn">&times;</button>
      </div>

      <!-- Review UI (replaces normal form when context is __type: review) -->
      <div v-if="reviewContext" class="detail-content detail-content--review">
        <DocumentReviewUI
          :question="question"
          :reviewContext="reviewContext"
          @answered="emit('answered', $event)"
        />
      </div>

      <!-- Variant Selection UI (replaces normal form when content type is variants) -->
      <div v-else-if="isVariantsContent" class="detail-content detail-content--variants">
        <VariantSelectionUI
          :question="question"
          @answered="emit('answered', $event)"
        />
      </div>

      <div v-else class="detail-content">
        <div class="question-info">
          <div class="info-row">
            <label>Minion:</label>
            <span class="monospace">{{ question.minionId }}</span>
          </div>
          <div class="info-row">
            <label>Wing:</label>
            <span>{{ question.wingName }}</span>
          </div>
          <div class="info-row">
            <label>Asked:</label>
            <span>{{ formatTimestamp(question.timestamp) }}</span>
          </div>
        </div>

        <div class="question-section">
          <label>Question:</label>
          <div class="question-text">{{ question.question }}</div>
        </div>

        <div v-if="question.content" class="context-section">
          <label>Context:</label>
          <div v-if="question.content.type === 'markdown'" class="context-text markdown-content" v-html="renderedMarkdown"></div>
          <div v-else-if="question.content.type === 'html'" class="context-text" v-html="question.content.content"></div>
        </div>

        <form @submit.prevent="handleSubmit">
          <div
            v-for="control in question.controls ?? []"
            :key="control.name"
            class="control-section"
          >
            <label :for="'control-' + control.name">{{ control.label }} <span v-if="control.hint" class="control-hint">({{ control.hint }})</span></label>
            <textarea
              v-if="control.type === 'textarea'"
              :id="'control-' + control.name"
              :value="controlValues[control.name] ?? ''"
              @input="setControlValue(control.name, ($event.target as HTMLTextAreaElement).value)"
              :rows="control.rows ?? 4"
              :placeholder="control.placeholder ?? ''"
              :disabled="submitting"
            ></textarea>
          </div>

          <div v-if="question.options && question.options.length > 0" class="options-section">
            <div v-if="question.optionsMode === 'exclusive'">
              <label>Quick Answers:</label>
              <div class="options-list">
                <button
                  v-for="opt in question.options"
                  :key="opt.value"
                  type="button"
                  class="option-btn"
                  :disabled="submitting"
                  @click="selectExclusive(opt)"
                >
                  {{ opt.label }}
                </button>
              </div>
            </div>
            <div v-else>
              <label>Select All That Apply:</label>
              <p class="multi-select-hint">Click to toggle options — select as many as you like, then submit.</p>
              <div class="options-list toggle-options">
                <button
                  v-for="opt in question.options"
                  :key="opt.value"
                  type="button"
                  :class="['toggle-btn', { 'toggle-btn--selected': selectedOptions.includes(opt.value) }]"
                  :disabled="submitting"
                  @click="toggleOption(opt.value)"
                >
                  <span class="toggle-check">{{ selectedOptions.includes(opt.value) ? '✓' : '' }}</span>
                  <span class="toggle-label">{{ opt.label }}</span>
                  <span v-if="opt.description" class="toggle-description">{{ opt.description }}</span>
                </button>
              </div>
              <p v-if="selectedOptions.length > 0" class="selection-count">{{ selectedOptions.length }} selected</p>
            </div>
          </div>

          <div class="answer-section">
            <label for="answer">Your Answer:</label>
            <textarea
              id="answer"
              v-model="answer"
              rows="6"
              placeholder="Type your answer here..."
              :disabled="submitting"
            ></textarea>
          </div>

          <div v-if="error" class="error">
            {{ error }}
          </div>

          <div class="form-actions">
            <button
              type="button"
              @click="$emit('close')"
              :disabled="submitting"
              class="cancel-btn"
            >
              Cancel
            </button>
            <button
              v-if="question.optionsMode !== 'exclusive' || (question.options ?? []).length === 0 || answer.trim().length > 0"
              type="submit"
              :disabled="submitting"
              class="submit-btn"
            >
              <span v-if="submitting">Submitting...</span>
              <span v-else-if="question.optionsMode === 'non-exclusive' && selectedOptions.length > 0">
                Submit ({{ selectedOptions.length }} selected)
              </span>
              <span v-else>Submit Answer</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { marked } from 'marked';
import { callMCPThroneRaw } from '../api/cabinet';
import type { AskResult } from '@minions/mcp-types';
import type { Question } from '../types/question';
import DocumentReviewUI from './DocumentReviewUI.vue';
import type { ReviewContext } from './DocumentReviewUI.vue';
import VariantSelectionUI from './VariantSelectionUI.vue';

// Configure marked to open links in new tabs
const renderer = new marked.Renderer();
const originalLinkRenderer = renderer.link.bind(renderer);
renderer.link = function (token) {
  const html = originalLinkRenderer(token);
  return html.replace('<a ', '<a target="_blank" rel="noopener noreferrer" ');
};
marked.use({ renderer });

const props = defineProps<{
  question: Question;
}>();

const emit = defineEmits<{
  answered: [questionId: string];
  close: [];
}>();

const answer = ref('');
const selectedOptions = ref<string[]>([]);
const controlValues = ref<Record<string, string>>({});
const submitting = ref(false);
const error = ref<string | null>(null);

const renderedMarkdown = computed(() => {
  if (!props.question.content || props.question.content.type !== 'markdown') return '';
  return marked.parse(props.question.content.content) as string;
});

function parseReviewContext(content: { type: string; content: string } | undefined): ReviewContext | null {
  if (!content || content.type !== 'review') return null;
  try {
    const parsed = JSON.parse(content.content);
    if (parsed && parsed.__type === 'review') return parsed as ReviewContext;
  } catch {
    // Not valid JSON
  }
  return null;
}

const reviewContext = computed(() => parseReviewContext(props.question.content));

const isVariantsContent = computed(() => props.question.content?.type === 'variants');

function setControlValue(name: string, value: string) {
  controlValues.value[name] = value;
}

function toggleOption(value: string) {
  const idx = selectedOptions.value.indexOf(value);
  if (idx === -1) {
    selectedOptions.value.push(value);
  } else {
    selectedOptions.value.splice(idx, 1);
  }
}

function buildAnswer(): string {
  const result: Record<string, unknown> = {};
  if (answer.value.trim()) result.answer = answer.value.trim();
  if (selectedOptions.value.length) result.selectedOptions = selectedOptions.value;
  for (const control of props.question.controls ?? []) {
    const v = (controlValues.value[control.name] ?? '').trim();
    if (v) result[control.name] = v;
  }
  return JSON.stringify(result);
}

async function selectExclusive(opt: { value: string; label: string }) {
  // Auto-submit: set answer = label so matchSuggestion still works
  answer.value = opt.label;
  await handleSubmit();
}

async function handleSubmit() {
  try {
    submitting.value = true;
    error.value = null;

    await callMCPThroneRaw<AskResult>('ask', {
      action: 'answer',
      questionId: props.question.id,
      answer: buildAnswer()
    });

    emit('answered', props.question.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to submit answer';
  } finally {
    submitting.value = false;
  }
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}
</script>

<style scoped>
.question-detail-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.question-detail {
  background: white;
  border-radius: 8px;
  max-width: 800px;
  width: 90%;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

/* Review UI needs more space */
.question-detail--review {
  max-width: 1100px;
  width: 94%;
  max-height: 92vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.detail-content--review {
  flex: 1;
  min-height: 0;
  padding: 16px 24px;
  display: flex;
  flex-direction: column;
}

/* Variant selection needs wide space for side-by-side view */
.question-detail--variants {
  max-width: 1200px;
  width: 96%;
  max-height: 92vh;
  overflow-y: auto;
}

.detail-content--variants {
  padding: 16px 24px 24px;
}

.detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 24px;
  border-bottom: 1px solid #ddd;
}

.detail-header h3 {
  margin: 0;
}

.close-btn {
  background: none;
  border: none;
  font-size: 28px;
  color: #999;
  cursor: pointer;
  line-height: 1;
  padding: 0;
  width: 32px;
  height: 32px;
}

.close-btn:hover {
  color: #333;
}

.detail-content {
  padding: 24px;
}

.question-info {
  background: #f5f5f5;
  padding: 16px;
  border-radius: 4px;
  margin-bottom: 20px;
}

.info-row {
  display: flex;
  gap: 12px;
  margin-bottom: 8px;
}

.info-row:last-child {
  margin-bottom: 0;
}

.info-row label {
  font-weight: 600;
  color: #666;
  min-width: 80px;
}

.monospace {
  font-family: monospace;
}

.question-section,
.context-section,
.answer-section,
.control-section {
  margin-bottom: 20px;
}

.question-section label,
.context-section label,
.answer-section label,
.control-section label {
  display: block;
  font-weight: 600;
  margin-bottom: 8px;
  color: #333;
}

.question-text {
  padding: 16px;
  background: #fff3e0;
  border-left: 4px solid #ff9800;
  border-radius: 4px;
  font-size: 16px;
  line-height: 1.5;
}

.context-text {
  padding: 16px;
  background: #f5f5f5;
  border-radius: 4px;
  word-wrap: break-word;
  max-height: 60vh;
  overflow-y: auto;
  line-height: 1.6;
  font-size: 14px;
}

.markdown-content :deep(h1),
.markdown-content :deep(h2),
.markdown-content :deep(h3) {
  margin-top: 16px;
  margin-bottom: 8px;
}

.markdown-content :deep(h1:first-child),
.markdown-content :deep(h2:first-child),
.markdown-content :deep(h3:first-child) {
  margin-top: 0;
}

.markdown-content :deep(p) {
  margin: 8px 0;
}

.markdown-content :deep(ul),
.markdown-content :deep(ol) {
  padding-left: 24px;
  margin: 8px 0;
}

.markdown-content :deep(code) {
  background: #e8e8e8;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 13px;
}

.markdown-content :deep(pre) {
  background: #2d2d2d;
  color: #f8f8f2;
  padding: 12px;
  border-radius: 4px;
  overflow-x: auto;
  margin: 12px 0;
}

.markdown-content :deep(pre code) {
  background: none;
  padding: 0;
  color: inherit;
}

.markdown-content :deep(a) {
  color: #1976d2;
  text-decoration: underline;
}

.markdown-content :deep(a:hover) {
  color: #1565c0;
}

.markdown-content :deep(blockquote) {
  border-left: 4px solid #ddd;
  margin: 12px 0;
  padding: 8px 16px;
  color: #666;
}

.options-section {
  margin-bottom: 20px;
}

.options-section label {
  display: block;
  font-weight: 600;
  margin-bottom: 8px;
  color: #333;
}

.options-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.toggle-options {
  flex-direction: column;
  gap: 6px;
}

.option-btn {
  padding: 8px 16px;
  background: #e3f2fd;
  border: 2px solid #1976d2;
  border-radius: 20px;
  color: #1976d2;
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.option-btn:hover:not(:disabled) {
  background: #1976d2;
  color: white;
}

.option-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.multi-select-hint {
  font-size: 13px;
  color: #666;
  margin: 4px 0 10px;
  font-style: italic;
}

.selection-count {
  font-size: 13px;
  color: #1976d2;
  font-weight: 600;
  margin: 8px 0 0;
}

.toggle-btn {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 14px;
  background: #f5f5f5;
  border: 2px solid #ddd;
  border-radius: 6px;
  color: #333;
  font-size: 14px;
  cursor: pointer;
  text-align: left;
  transition: all 0.15s ease;
  width: 100%;
}

.toggle-btn:hover:not(:disabled) {
  border-color: #1976d2;
  background: #e8f0fe;
}

.toggle-btn--selected {
  background: #e3f2fd;
  border-color: #1976d2;
  color: #1565c0;
}

.toggle-btn--selected:hover:not(:disabled) {
  background: #bbdefb;
}

.toggle-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.toggle-check {
  font-size: 16px;
  font-weight: 700;
  color: #1976d2;
  width: 18px;
  flex-shrink: 0;
  line-height: 1.2;
}

.toggle-label {
  font-weight: 600;
  flex-shrink: 0;
}

.toggle-description {
  color: #666;
  font-size: 13px;
  font-weight: 400;
}

.answer-section textarea,
.control-section textarea {
  width: 100%;
  padding: 12px;
  border: 2px solid #ddd;
  border-radius: 4px;
  font-size: 14px;
  font-family: inherit;
  resize: vertical;
  box-sizing: border-box;
}

.answer-section textarea:focus,
.control-section textarea:focus {
  outline: none;
  border-color: #1976d2;
}

.answer-section textarea:disabled,
.control-section textarea:disabled {
  background: #f5f5f5;
  cursor: not-allowed;
}

.control-hint {
  font-weight: 400;
  color: #888;
  font-size: 13px;
}

.error {
  padding: 12px;
  background: #fee;
  border: 1px solid #fcc;
  border-radius: 4px;
  color: #c00;
  margin-bottom: 20px;
}

.form-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

.form-actions button {
  padding: 12px 24px;
  border: none;
  border-radius: 4px;
  font-weight: 600;
  cursor: pointer;
  font-size: 14px;
}

.cancel-btn {
  background: #f5f5f5;
  color: #333;
}

.cancel-btn:hover:not(:disabled) {
  background: #e0e0e0;
}

.submit-btn {
  background: #1976d2;
  color: white;
}

.submit-btn:hover:not(:disabled) {
  background: #1565c0;
}

.form-actions button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
