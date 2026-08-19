<template>
  <div class="wing-management">
    <div class="wing-header">
      <h2>{{ wing.name }}</h2>
      <p class="wing-root">{{ wing.root }}</p>
    </div>

    <div class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        :class="['tab-button', { active: activeTab === tab.id, 'has-questions': tab.id === 'questions' && openQuestionCount > 0 }]"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
      </button>
    </div>

    <div class="tab-content">
      <!-- Overview Tab -->
      <div v-if="activeTab === 'overview'" class="tab-panel">
        <WingDetail :wing="currentWing" />
        <div class="mappings-section">
          <WingWorkMappingsEditor :wing="currentWing" @updated="handleWingUpdated" />
        </div>
      </div>

      <!-- Minions Tab -->
      <div v-if="activeTab === 'minions'" class="tab-panel">
        <!-- Minion List View -->
        <div v-if="!selectedMinionId && !showSpawnForm">
          <div class="minions-header">
            <h3>Minions</h3>
            <button @click="showSpawnForm = true" class="spawn-btn">
              + Spawn Minion
            </button>
          </div>
          <MinionList
            ref="minionList"
            :wing-name="wing.name"
            @select="selectMinion"
          />
        </div>

        <!-- Spawn Form -->
        <div v-if="showSpawnForm">
          <MinionSpawnForm
            :wing-name="wing.name"
            @created="handleMinionCreated"
            @cancel="showSpawnForm = false"
          />
        </div>

        <!-- Debug View -->
        <div v-if="selectedMinionId">
          <button @click="selectedMinionId = null" class="back-btn">
            ← Back to Minions
          </button>
          <MinionDebugView
            :minion-id="selectedMinionId"
            @killed="handleMinionKilled"
          />
        </div>
      </div>

      <!-- Questions Tab -->
      <div v-if="activeTab === 'questions'" class="tab-panel">
        <QuestionsList
          :wing-name="wing.name"
          @select="handleQuestionSelect"
          ref="questionsListRef"
        />
      </div>

      <!-- Missions Tab -->
      <div v-if="activeTab === 'missions'" class="tab-panel">
        <MissionManagement :wing-name="wing.name" />
      </div>
    </div>

    <!-- Question Detail Modal -->
    <QuestionDetail
      v-if="selectedQuestion"
      :question="selectedQuestion"
      @answered="handleQuestionAnswered"
      @close="selectedQuestion = null"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue';
import { callMCPThroneRaw, questionEvents, type QuestionEventNotification } from '../api/cabinet';
import type { AskResult } from '@minions/mcp-types';
import WingDetail from './WingDetail.vue';
import WingWorkMappingsEditor from './WingWorkMappingsEditor.vue';
import MinionList from './MinionList.vue';
import MinionSpawnForm from './MinionSpawnForm.vue';
import MinionDebugView from './MinionDebugView.vue';
import QuestionsList from './QuestionsList.vue';
import QuestionDetail from './QuestionDetail.vue';
import MissionManagement from './MissionManagement.vue';
import type { Wing } from '../types/wing';
import type { Question } from '../types/question';

const props = defineProps<{
  wing: Wing;
}>();

// Local copy of wing data so work-mapping updates are reflected immediately
const currentWing = ref<Wing>({ ...props.wing });
watch(() => props.wing, (w) => { currentWing.value = { ...w }; });

function handleWingUpdated(updatedWing: Wing) {
  currentWing.value = { ...currentWing.value, ...updatedWing };
}

const openQuestionCount = ref(0);

const tabs = computed(() => [
  { id: 'overview', label: 'Overview' },
  { id: 'minions', label: 'Minions' },
  { id: 'missions', label: 'Missions' },
  { id: 'questions', label: openQuestionCount.value > 0 ? `Questions (${openQuestionCount.value})` : 'Questions' }
]);

const activeTab = ref('overview');
const selectedMinionId = ref<string | null>(null);
const showSpawnForm = ref(false);
const minionList = ref<InstanceType<typeof MinionList> | null>(null);
const questionsListRef = ref<InstanceType<typeof QuestionsList> | null>(null);
const selectedQuestion = ref<Question | null>(null);

function selectMinion(minionId: string) {
  selectedMinionId.value = minionId;
}

function handleMinionCreated() {
  showSpawnForm.value = false;
  // Refresh minion list
  if (minionList.value) {
    minionList.value.loadMinions();
  }
}

function handleMinionKilled() {
  selectedMinionId.value = null;
  // Refresh minion list
  if (minionList.value) {
    minionList.value.loadMinions();
  }
}

function handleQuestionSelect(question: Question) {
  selectedQuestion.value = question;
}

function handleQuestionAnswered() {
  selectedQuestion.value = null;
  questionsListRef.value?.loadQuestions();
}

// Track open question count at the WingManagement level (always mounted)
let unsubscribeQuestions: (() => void) | null = null;

function handleQuestionNotification(notification: QuestionEventNotification) {
  if (props.wing.name && notification.question.wingName !== props.wing.name) {
    return;
  }
  if (notification.type === 'question_added') {
    openQuestionCount.value++;
  } else if (notification.type === 'question_answered' || notification.type === 'question_cancelled') {
    openQuestionCount.value = Math.max(0, openQuestionCount.value - 1);
  }
}

async function loadOpenQuestionCount() {
  try {
    const result = await callMCPThroneRaw<AskResult>('ask', { action: 'list', wingName: props.wing.name });
    openQuestionCount.value = 'questions' in result ? result.questions.length : 0;
  } catch {
    // Ignore errors in question count
  }
}

onMounted(async () => {
  await loadOpenQuestionCount();
  unsubscribeQuestions = questionEvents.subscribe(handleQuestionNotification);
});

onUnmounted(() => {
  if (unsubscribeQuestions) {
    unsubscribeQuestions();
    unsubscribeQuestions = null;
  }
});
</script>

<style scoped>
.wing-management {
  background: white;
  border-radius: 8px;
  padding: 20px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.wing-header {
  margin-bottom: 24px;
  border-bottom: 2px solid #e0e0e0;
  padding-bottom: 16px;
}

.wing-header h2 {
  margin: 0 0 8px 0;
  color: #333;
}

.wing-root {
  margin: 0;
  font-family: monospace;
  color: #666;
  font-size: 14px;
}

.tabs {
  display: flex;
  gap: 8px;
  border-bottom: 2px solid #e0e0e0;
  margin-bottom: 20px;
}

.tab-button {
  padding: 12px 24px;
  background: none;
  border: none;
  border-bottom: 3px solid transparent;
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  color: #666;
  transition: all 0.2s;
}

.tab-button:hover {
  color: #333;
  background: #f5f5f5;
}

.tab-button.active {
  color: #1976d2;
  border-bottom-color: #1976d2;
}

.tab-button.has-questions {
  color: #ff9800;
  font-weight: 700;
  animation: pulse-attention 2s ease-in-out infinite;
}

.tab-button.has-questions.active {
  color: #ff9800;
  border-bottom-color: #ff9800;
}

@keyframes pulse-attention {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

.tab-content {
  min-height: 400px;
}

.tab-panel {
  animation: fadeIn 0.2s;
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.minions-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.minions-header h3 {
  margin: 0;
}

.spawn-btn {
  padding: 10px 20px;
  background: #1976d2;
  color: white;
  border: none;
  border-radius: 4px;
  font-weight: 600;
  cursor: pointer;
  font-size: 14px;
}

.spawn-btn:hover {
  background: #1565c0;
}

.back-btn {
  padding: 8px 16px;
  background: #f5f5f5;
  color: #333;
  border: 1px solid #ddd;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  margin-bottom: 16px;
}

.back-btn:hover {
  background: #e0e0e0;
}

.mappings-section {
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid #eee;
}
</style>
