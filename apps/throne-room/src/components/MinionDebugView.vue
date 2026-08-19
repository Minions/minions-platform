<template>
  <div class="minion-debug-view">
    <!-- Show list view when no interaction selected -->
    <div v-if="!selectedInteractionId">
      <div class="debug-header">
        <h3>Debug View: {{ minionId }}</h3>
        <button @click="showKillDialog = true" class="kill-btn">
          Kill Minion
        </button>
      </div>

      <StateDisplay
        :loading="loading"
        :error="error"
        loading-text="Loading interactions..."
      >
        <div class="debug-content">
      <div class="interactions-list" ref="interactionsContainer">
        <div v-if="interactions.length === 0" class="empty">
          No interactions yet. Send a message below to start.
        </div>

        <div
          v-for="interaction in interactions"
          :key="interaction.id"
          class="interaction-item"
          :class="`status-${interaction.status}`"
          @click="selectInteraction(interaction.id)"
        >
          <div class="interaction-header">
            <span class="interaction-time">
              {{ formatTime(interaction.timestamp) }}
            </span>
            <span class="interaction-status" :class="`status-${interaction.status}`">
              {{ interaction.status }}
            </span>
          </div>

          <div class="interaction-prompt">
            {{ interaction.promptSummary }}
          </div>

          <div class="interaction-meta">
            <span class="block-count">{{ interaction.blockCount }} blocks</span>
          </div>
        </div>
      </div>

      <!-- Message input section -->
      <div class="message-input-container">
        <textarea
          v-model="messageInput"
          @keydown.ctrl.enter="sendMessage"
          placeholder="Send a message to the minion... (Ctrl+Enter to send)"
          class="message-input"
          :disabled="sending"
        ></textarea>
        <button
          @click="sendMessage"
          class="send-btn"
          :disabled="!messageInput.trim() || sending"
        >
          {{ sending ? 'Sending...' : 'Send' }}
        </button>
      </div>
        </div>
      </StateDisplay>
    </div>

    <!-- Show detail view when interaction selected -->
    <InteractionDetail
      v-else-if="selectedInteraction"
      :interaction="selectedInteraction"
      @close="closeDetail"
    />

    <KillMinionDialog
      v-if="showKillDialog"
      :minion-id="minionId"
      @killed="handleKilled"
      @cancel="showKillDialog = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { callMCPThrone, callMCPStreamingConductor } from '../api/cabinet';
import KillMinionDialog from './KillMinionDialog.vue';
import InteractionDetail from './InteractionDetail.vue';
import type { InteractionSummary, MinionsGetInteractionDetailResult, MinionsGetInteractionsResult } from '@minions/mcp-types';
import StateDisplay from './StateDisplay.vue';

const props = defineProps<{
  minionId: string;
}>();

const emit = defineEmits<{
  'select-interaction': [interactionId: string];
  'killed': [minionId: string, dumpPath: string];
}>();

const interactions = ref<InteractionSummary[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const messageInput = ref('');
const sending = ref(false);
const showKillDialog = ref(false);
const interactionsContainer = ref<HTMLElement | null>(null);
const selectedInteractionId = ref<string | null>(null);
const selectedInteraction = ref<MinionsGetInteractionDetailResult | null>(null);

async function loadInteractions() {
  try {
    loading.value = true;
    error.value = null;

    const result = await callMCPThrone('minions', {
      action: 'get_interactions',
      minionId: props.minionId
    });

    interactions.value = (result as MinionsGetInteractionsResult).interactions;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load interactions';
  } finally {
    loading.value = false;
  }
}

async function sendMessage() {
  const message = messageInput.value.trim();
  if (!message || sending.value) return;

  try {
    sending.value = true;
    error.value = null;

    // Clear input immediately for better UX
    messageInput.value = '';

    // Send message with streaming - each event triggers a UI refresh
    await callMCPStreamingConductor(
      'minions',
      {
        action: 'send_message',
        minionId: props.minionId,
        message: message
      },
      async (event) => {
        // Reload interactions on each streaming event for real-time updates
        if (event.type === 'content' || event.type === 'user_message') {
          await loadInteractions();
          // Also refresh selected interaction details if viewing one
          if (selectedInteractionId.value && selectedInteraction.value) {
            try {
              const result = await callMCPThrone('minions', {
                action: 'get_interaction_detail',
                minionId: props.minionId,
                interactionId: selectedInteractionId.value
              });
              selectedInteraction.value = result as MinionsGetInteractionDetailResult;
            } catch {
              // Ignore errors during streaming refresh
            }
          }
        }
      }
    );

    // Final reload to ensure we have the complete interaction
    await loadInteractions();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to send message';
  } finally {
    sending.value = false;
  }
}

async function selectInteraction(interactionId: string) {
  try {
    error.value = null;
    selectedInteractionId.value = interactionId;

    const result = await callMCPThrone('minions', {
      action: 'get_interaction_detail',
      minionId: props.minionId,
      interactionId: interactionId
    });

    selectedInteraction.value = result as MinionsGetInteractionDetailResult;
    emit('select-interaction', interactionId);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load interaction details';
    selectedInteractionId.value = null;
  }
}

function closeDetail() {
  selectedInteractionId.value = null;
  selectedInteraction.value = null;
}

function handleKilled(dumpPath: string) {
  showKillDialog.value = false;
  emit('killed', props.minionId, dumpPath);
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

onMounted(async () => {
  await loadInteractions();
});
</script>

<style scoped>
.minion-debug-view {
  background: white;
  border: 1px solid #ddd;
  border-radius: 8px;
  height: 600px;
  display: flex;
  flex-direction: column;
}

.debug-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid #ddd;
  background: #f5f5f5;
}

.debug-header h3 {
  margin: 0;
  font-size: 16px;
  font-family: monospace;
}

.kill-btn {
  padding: 8px 16px;
  background: #d32f2f;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
}

.kill-btn:hover {
  background: #b71c1c;
}

.debug-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.interactions-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.interaction-item {
  padding: 12px 16px;
  margin-bottom: 8px;
  border: 1px solid #ddd;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
}

.interaction-item:hover {
  background: #f9f9f9;
  border-color: #1976d2;
}

.interaction-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
  font-size: 12px;
}

.interaction-time {
  color: #666;
  font-family: monospace;
}

.interaction-status {
  font-weight: 600;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 10px;
}

.status-completed {
  background: #c8e6c9;
  color: #2e7d32;
}

.status-error {
  background: #ffcdd2;
  color: #c62828;
}

.status-streaming {
  background: #fff9c4;
  color: #f57f17;
}

.status-pending {
  background: #e0e0e0;
  color: #616161;
}

.interaction-prompt {
  font-size: 14px;
  margin-bottom: 8px;
  color: #333;
  font-family: monospace;
}

.interaction-meta {
  font-size: 12px;
  color: #999;
}

.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #666;
  padding: 20px;
  text-align: center;
}

.message-input-container {
  border-top: 1px solid #ddd;
  padding: 16px;
  background: #fafafa;
  display: flex;
  gap: 12px;
}

.message-input {
  flex: 1;
  padding: 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-family: inherit;
  font-size: 14px;
  resize: vertical;
  min-height: 60px;
}

.message-input:focus {
  outline: none;
  border-color: #1976d2;
}

.message-input:disabled {
  background: #f5f5f5;
  cursor: not-allowed;
}

.send-btn {
  padding: 12px 24px;
  background: #1976d2;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  white-space: nowrap;
}

.send-btn:hover:not(:disabled) {
  background: #1565c0;
}

.send-btn:disabled {
  background: #ccc;
  cursor: not-allowed;
}
</style>
