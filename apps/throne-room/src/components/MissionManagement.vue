<!--
/**
 * MissionManagement Component
 *
 * Container component for mission-related functionality.
 * Integrates MissionList, MissionStartForm, MissionEventStream, and RunningMissions.
 * Manages state transitions between listing, starting, and viewing missions.
 *
 * @component
 */
-->
<template>
  <div class="mission-management">
    <!-- Running Missions Sidebar -->
    <div class="running-missions-sidebar">
      <RunningMissions @select="handleRunningMissionSelect" />
    </div>

    <!-- Mission List View -->
    <div v-if="view === 'list'" class="mission-list-view">
      <MissionList
        :wing-name="wingName"
        @select="handleMissionSelect"
        ref="missionListRef"
      />
    </div>

    <!-- Mission Start Form -->
    <div v-else-if="view === 'start' && selectedMission" class="mission-start-view">
      <button class="back-button" @click="goBackToList">
        &larr; Back to Missions
      </button>

      <MissionStartForm
        :wing-name="wingName"
        :mission="selectedMission"
        @started="handleMissionStarted"
        @cancel="goBackToList"
      />
    </div>

    <!-- Mission Event Stream -->
    <div v-else-if="view === 'stream' && activeMission" class="mission-stream-view">
      <MissionEventStream
        :key="activeMission.missionRunId"
        :mission-run-id="activeMission.missionRunId"
        :mission-name="activeMission.missionName"
        :costume="activeMission.costume"
        @close="handleStreamClose"
      />

      <!-- Show questions related to this mission -->
      <div class="mission-questions">
        <QuestionsList
          :wing-name="wingName"
          @select="handleQuestionSelect"
          ref="questionsListRef"
        />
      </div>
    </div>

    <!-- Question Detail Modal -->
    <QuestionDetail
      v-if="selectedQuestion"
      :question="selectedQuestion"
      @answered="handleQuestionAnswered"
      @close="closeQuestionDetail"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { MissionSummary_ } from '@minions/mcp-types';
import type { Question } from '../types/question';
import MissionList from './MissionList.vue';
import MissionStartForm from './MissionStartForm.vue';
import MissionEventStream from './MissionEventStream.vue';
import RunningMissions, { type TrackedMission } from './RunningMissions.vue';
import QuestionsList from './QuestionsList.vue';
import QuestionDetail from './QuestionDetail.vue';

defineProps<{
  wingName: string;
}>();

type View = 'list' | 'start' | 'stream';

interface ActiveMission {
  missionRunId: string;
  missionName: string;
  costume: string;
}

const view = ref<View>('list');
const selectedMission = ref<MissionSummary_ | null>(null);
const activeMission = ref<ActiveMission | null>(null);
const selectedQuestion = ref<Question | null>(null);

const missionListRef = ref<InstanceType<typeof MissionList> | null>(null);
const questionsListRef = ref<InstanceType<typeof QuestionsList> | null>(null);

/**
 * Handle mission selection from list
 */
function handleMissionSelect(mission: MissionSummary_) {
  selectedMission.value = mission;
  view.value = 'start';
}

/**
 * Handle successful mission start
 */
function handleMissionStarted(result: { missionRunId: string; missionName: string; costume: string }) {
  activeMission.value = result;
  selectedMission.value = null;
  view.value = 'stream';
}

/**
 * Handle selection from running missions list
 */
function handleRunningMissionSelect(mission: TrackedMission) {
  activeMission.value = {
    missionRunId: mission.missionRunId,
    missionName: mission.missionName,
    costume: mission.costume,
  };
  view.value = 'stream';
}

/**
 * Go back to mission list
 */
function goBackToList() {
  selectedMission.value = null;
  view.value = 'list';
  // Refresh the list
  missionListRef.value?.loadMissions();
}

/**
 * Handle stream view close
 */
function handleStreamClose() {
  activeMission.value = null;
  view.value = 'list';
  // Refresh the list
  missionListRef.value?.loadMissions();
}

/**
 * Handle question selection
 */
function handleQuestionSelect(question: Question) {
  selectedQuestion.value = question;
}

/**
 * Handle question answered
 */
function handleQuestionAnswered() {
  selectedQuestion.value = null;
  // Refresh the questions list
  questionsListRef.value?.loadQuestions();
}

/**
 * Close question detail modal
 */
function closeQuestionDetail() {
  selectedQuestion.value = null;
}
</script>

<style scoped>
.mission-management {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: 20px;
  position: relative;
}

.running-missions-sidebar {
  position: sticky;
  top: 20px;
  align-self: start;
}

.back-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  margin-bottom: 16px;
  border: 1px solid #ddd;
  border-radius: 4px;
  background: white;
  color: #666;
  font-weight: 500;
  cursor: pointer;
}

.back-button:hover {
  background: #f5f5f5;
  color: #333;
}

.mission-questions {
  margin-top: 24px;
}
</style>
