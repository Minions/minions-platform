<!--
/**
 * MissionEventStream Component
 *
 * Displays real-time events from a running mission.
 * Receives events via MCP notifications (no polling).
 * Shows mission status and allows cancellation.
 *
 * @component
 * @emits {close} - Emitted when the user closes the stream view
 */
-->
<template>
  <div class="mission-event-stream">
    <div class="stream-header">
      <div class="header-info">
        <h3>{{ missionName }}</h3>
        <span class="costume-badge">{{ costume }}</span>
        <span :class="['status-badge', `status-${status}`]">
          {{ formatStatus(status) }}
        </span>
      </div>

      <div class="header-actions">
        <button
          :class="['debug-toggle', { 'debug-toggle--active': showDebug }]"
          @click="showDebug = !showDebug"
          title="Show/hide debug messages from spawned minions"
        >
          Debug
        </button>
        <button
          v-if="status === 'running'"
          class="cancel-button"
          @click="cancelMission"
          :disabled="cancelling"
        >
          {{ cancelling ? 'Cancelling...' : 'Cancel' }}
        </button>
        <button class="close-button" @click="$emit('close')">
          Close
        </button>
      </div>
    </div>

    <div class="events-container" ref="eventsContainer">
      <div v-if="isLoading" class="loading-events">
        Loading events...
      </div>
      <div v-else-if="events.length === 0 && status === 'running'" class="loading-events">
        Waiting for events...
      </div>

      <div
        v-for="(event, index) in visibleEvents"
        :key="index"
        :class="['event-item', `event-${event.type}`, event.type === 'log' && event.data.level === 'debug' ? 'event-log--debug' : '']"
      >
        <div class="event-header">
          <span class="event-type">{{ formatEventType(event.type) }}</span>
          <span class="event-time">{{ formatTime(event.timestamp) }}</span>
        </div>

        <div class="event-content">
          <!-- Started event -->
          <template v-if="event.type === 'started'">
            Mission started
          </template>

          <!-- Completed event -->
          <template v-else-if="event.type === 'completed'">
            <div class="completion-message">
              Mission completed successfully
            </div>
            <pre v-if="event.data.result" class="event-data">{{ formatData(event.data.result) }}</pre>
          </template>

          <!-- Failed event -->
          <template v-else-if="event.type === 'failed'">
            <div class="error-message">
              {{ event.data.error || 'Mission failed' }}
            </div>
          </template>

          <!-- Cancelled event -->
          <template v-else-if="event.type === 'cancelled'">
            <div class="cancelled-message">
              Mission cancelled{{ event.data.reason ? `: ${event.data.reason}` : '' }}
            </div>
          </template>

          <!-- Progress event -->
          <template v-else-if="event.type === 'progress'">
            <div class="progress-message">
              {{ event.data.message || 'Processing...' }}
            </div>
            <div v-if="event.data.progress !== undefined" class="progress-bar">
              <div
                class="progress-fill"
                :style="{ width: `${(event.data.progress as number) * 100}%` }"
              ></div>
            </div>
          </template>

          <!-- Log event -->
          <template v-else-if="event.type === 'log'">
            <pre class="log-content">{{ event.data.message || formatData(event.data) }}</pre>
          </template>

          <!-- Minion spawned event -->
          <template v-else-if="event.type === 'minion_spawned'">
            <div class="minion-event">
              Spawned minion: <code>{{ event.data.minionId }}</code>
            </div>
          </template>

          <!-- Minion message event -->
          <template v-else-if="event.type === 'minion_message'">
            <div class="minion-message">
              <code>{{ event.data.minionId }}</code>:
              <span>{{ event.data.content }}</span>
            </div>
          </template>

          <!-- Question asked event -->
          <template v-else-if="event.type === 'question_asked'">
            <div class="question-event">
              Question: {{ event.data.question }}
            </div>
          </template>

          <!-- Question answered event -->
          <template v-else-if="event.type === 'question_answered'">
            <div class="answer-event">
              Answer: {{ event.data.answer }}
            </div>
          </template>

          <!-- Generic event -->
          <template v-else>
            <pre class="event-data">{{ formatData(event.data) }}</pre>
          </template>
        </div>
      </div>
    </div>

    <div v-if="error" class="error-banner">
      {{ error }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, toRef, nextTick, watch } from 'vue';
import { callMCPConductor } from '../api/cabinet';
import { useMissionEvents } from '../composables/useMissionEvents';
import type { MissionRunStatus } from '@minions/mcp-types';

const props = defineProps<{
  missionRunId: string;
  missionName: string;
  costume: string;
}>();

defineEmits<{
  close: [];
}>();

// Use composable for reactive event subscription (no polling)
const missionRunIdRef = toRef(props, 'missionRunId');
const { events, status, error, isLoading } = useMissionEvents(missionRunIdRef);

const cancelling = ref(false);
const eventsContainer = ref<HTMLElement | null>(null);
const showDebug = ref(false);

const visibleEvents = computed(() =>
  showDebug.value
    ? events.value
    : events.value.filter(e => !(e.type === 'log' && e.data.level === 'debug'))
);

/**
 * Cancel the running mission
 */
async function cancelMission() {
  try {
    cancelling.value = true;
    await callMCPConductor('missions', {
      action: 'cancel',
      missionRunId: props.missionRunId,
      reason: 'Cancelled by user'
    });
    // Status will update via notification
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to cancel mission';
  } finally {
    cancelling.value = false;
  }
}

/**
 * Scroll events container to bottom
 */
async function scrollToBottom() {
  await nextTick();
  if (eventsContainer.value) {
    eventsContainer.value.scrollTop = eventsContainer.value.scrollHeight;
  }
}

/**
 * Format status for display
 */
function formatStatus(s: MissionRunStatus): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Format event type for display
 */
function formatEventType(type: string): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Format timestamp
 */
function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

/**
 * Format event data as JSON
 */
function formatData(data: unknown): string {
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

// Watch for new visible events to scroll
watch(
  () => visibleEvents.value.length,
  () => scrollToBottom()
);
</script>

<style scoped>
.mission-event-stream {
  background: white;
  border: 1px solid #ddd;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  height: 500px;
}

.stream-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid #ddd;
  flex-shrink: 0;
}

.header-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.header-info h3 {
  margin: 0;
  color: #333;
}

.costume-badge {
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  background: #e3f2fd;
  color: #1976d2;
}

.status-badge {
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
}

.status-running {
  background: #e8f5e9;
  color: #2e7d32;
}

.status-completed {
  background: #e3f2fd;
  color: #1976d2;
}

.status-failed {
  background: #ffebee;
  color: #c62828;
}

.status-cancelled {
  background: #fff3e0;
  color: #e65100;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.debug-toggle {
  padding: 8px 14px;
  border: 1px solid #ccc;
  border-radius: 4px;
  background: white;
  color: #999;
  font-weight: 600;
  font-size: 12px;
  cursor: pointer;
}

.debug-toggle:hover {
  background: #f5f5f5;
  border-color: #aaa;
}

.debug-toggle--active {
  background: #f3e5f5;
  border-color: #7b1fa2;
  color: #7b1fa2;
}

.event-log--debug {
  opacity: 0.6;
  border-style: dashed;
}

.event-log--debug .event-type::after {
  content: ' · debug';
  font-weight: 400;
  color: #bbb;
}

.cancel-button {
  padding: 8px 16px;
  border: 1px solid #f44336;
  border-radius: 4px;
  background: white;
  color: #f44336;
  font-weight: 600;
  cursor: pointer;
}

.cancel-button:hover:not(:disabled) {
  background: #ffebee;
}

.cancel-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.close-button {
  padding: 8px 16px;
  border: 1px solid #ddd;
  border-radius: 4px;
  background: white;
  color: #666;
  font-weight: 600;
  cursor: pointer;
}

.close-button:hover {
  background: #f5f5f5;
}

.events-container {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  background: #fafafa;
}

.loading-events {
  text-align: center;
  color: #666;
  padding: 40px;
}

.event-item {
  background: white;
  border: 1px solid #ddd;
  border-radius: 4px;
  padding: 12px;
  margin-bottom: 8px;
}

.event-item:last-child {
  margin-bottom: 0;
}

.event-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
}

.event-type {
  font-weight: 600;
  font-size: 12px;
  text-transform: uppercase;
  color: #666;
}

.event-time {
  font-size: 12px;
  color: #999;
  font-family: monospace;
}

.event-content {
  color: #333;
}

.event-started .event-type {
  color: #2e7d32;
}

.event-completed .event-type {
  color: #1976d2;
}

.event-failed .event-type {
  color: #c62828;
}

.event-cancelled .event-type {
  color: #e65100;
}

.event-progress .event-type {
  color: #7b1fa2;
}

.completion-message {
  color: #2e7d32;
  font-weight: 500;
}

.error-message {
  color: #c62828;
  font-weight: 500;
}

.cancelled-message {
  color: #e65100;
  font-weight: 500;
}

.progress-bar {
  height: 8px;
  background: #e0e0e0;
  border-radius: 4px;
  margin-top: 8px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: #7b1fa2;
  transition: width 0.3s;
}

.log-content {
  margin: 0;
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
  background: #f5f5f5;
  padding: 8px;
  border-radius: 4px;
}

.event-data {
  margin: 0;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  background: #f5f5f5;
  padding: 8px;
  border-radius: 4px;
  max-height: 200px;
  overflow-y: auto;
}

.minion-event,
.minion-message {
  font-size: 14px;
}

.minion-event code,
.minion-message code {
  background: #f5f5f5;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 12px;
}

.question-event {
  color: #7b1fa2;
  font-weight: 500;
}

.answer-event {
  color: #2e7d32;
}

.error-banner {
  padding: 12px 16px;
  background: #ffebee;
  border-top: 1px solid #ffcdd2;
  color: #c62828;
  flex-shrink: 0;
}
</style>
