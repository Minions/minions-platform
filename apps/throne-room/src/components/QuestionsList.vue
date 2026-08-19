<template>
  <div class="questions-list">
    <ListHeader :loading="loading" @refresh="loadQuestions">
      Open Questions ({{ questions.length }})
    </ListHeader>

    <StateDisplay
      :loading="loading"
      :error="error"
      :empty="questions.length === 0"
      loading-text="Loading questions..."
    >
      <template #empty>
        <p>No open questions</p>
        <p>Questions will appear here when minions use the Ask tool.</p>
      </template>

      <div class="questions-grid">
      <div
        v-for="question in questions"
        :key="question.id"
        class="question-card"
        @click="$emit('select', question)"
      >
        <div class="question-header">
          <div class="question-meta">
            <span class="minion-id">{{ question.minionId }}</span>
            <span class="wing-name">{{ question.wingName }}</span>
          </div>
          <div class="question-time">{{ formatTime(question.timestamp) }}</div>
        </div>

        <div class="question-content">
          {{ truncateQuestion(question.question) }}
        </div>

        <div class="question-footer">
          <button class="answer-btn" @click.stop="$emit('select', question)">
            View details
          </button>
        </div>
      </div>
      </div>
    </StateDisplay>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { callMCPThroneRaw, questionEvents, type QuestionEventNotification } from '../api/cabinet';
import type { AskResult } from '@minions/mcp-types';
import type { Question } from '../types/question';
import ListHeader from './ListHeader.vue';
import StateDisplay from './StateDisplay.vue';

const props = defineProps<{
  wingName?: string;
}>();

defineEmits<{
  select: [question: Question];
}>();

const questions = ref<Question[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

let unsubscribe: (() => void) | null = null;

async function loadQuestions() {
  try {
    loading.value = true;
    error.value = null;

    const args: Record<string, unknown> = {};
    if (props.wingName) {
      args.wingName = props.wingName;
    }

    const result = await callMCPThroneRaw<AskResult>('ask', { action: 'list', ...args });
    questions.value = 'questions' in result ? result.questions : [];
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load questions';
  } finally {
    loading.value = false;
  }
}

/**
 * Handle question events from the server
 */
function handleQuestionEvent(notification: QuestionEventNotification) {
  const { type, question } = notification;

  // Filter by wingName if specified
  if (props.wingName && question.wingName !== props.wingName) {
    return;
  }

  if (type === 'question_added') {
    // Add new question to the list
    questions.value = [...questions.value, question];
  } else if (type === 'question_answered' || type === 'question_cancelled') {
    // Remove answered/cancelled questions from the open list
    questions.value = questions.value.filter(q => q.id !== question.id);
  }
}

function formatTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function truncateQuestion(content: string): string {
  const maxLength = 150;
  if (content.length <= maxLength) return content;
  return content.substring(0, maxLength) + '...';
}

onMounted(async () => {
  // Load initial questions
  await loadQuestions();

  // Subscribe to real-time question events
  unsubscribe = questionEvents.subscribe(handleQuestionEvent);
});

onUnmounted(() => {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
});

defineExpose({ loadQuestions });
</script>

<style scoped>
.questions-list {
  margin-top: 20px;
}

.questions-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
}

.question-card {
  background: white;
  border: 2px solid #ff9800;
  border-left: 8px solid #ff9800;
  border-radius: 8px;
  padding: 16px;
  cursor: pointer;
  transition: all 0.2s;
}

.question-card:hover {
  border-color: #f57c00;
  box-shadow: 0 4px 12px rgba(255, 152, 0, 0.2);
}

.question-header {
  display: flex;
  justify-content: space-between;
  align-items: start;
  margin-bottom: 12px;
}

.question-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.minion-id {
  font-family: monospace;
  font-size: 13px;
  font-weight: 600;
  color: #333;
}

.wing-name {
  font-size: 12px;
  color: #666;
}

.question-time {
  font-size: 12px;
  color: #999;
}

.question-content {
  margin-bottom: 12px;
  line-height: 1.5;
  color: #333;
}

.question-footer {
  display: flex;
  justify-content: flex-end;
}

.answer-btn {
  padding: 8px 16px;
  background: #ff9800;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
}

.answer-btn:hover {
  background: #f57c00;
}
</style>
