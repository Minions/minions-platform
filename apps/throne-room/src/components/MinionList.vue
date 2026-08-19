<template>
  <div class="minion-list">
    <ListHeader :loading="loading" @refresh="loadMinions">
      Minions
    </ListHeader>

    <StateDisplay
      :loading="loading"
      :error="error"
      :empty="minions.length === 0"
      loading-text="Loading minions..."
    >
      <template #empty>
        <p>No minions spawned yet.</p>
        <p>Click "Spawn Minion" to create one.</p>
      </template>

      <div class="minions-grid">
      <div
        v-for="minion in minions"
        :key="minion.id"
        class="minion-card"
        @click="$emit('select', minion.id)"
      >
        <div class="minion-header">
          <div class="minion-id">{{ minion.id }}</div>
          <div class="minion-client" :class="`client-${minion.client}`">
            {{ formatClient(minion.client) }}
          </div>
        </div>

        <div class="minion-status" :class="`status-${minion.status}`">
          <span class="status-indicator"></span>
          {{ formatStatus(minion.status) }}
        </div>

        <div v-if="minion.createdAt" class="minion-meta">
          Created: {{ formatDate(minion.createdAt) }}
        </div>
      </div>
      </div>
    </StateDisplay>
  </div>
</template>

<script setup lang="ts">
/**
 * MinionList Component
 *
 * Displays a grid of all minions in a wing with their current status.
 * Shows client badges, status indicators with colors, and creation timestamps.
 * Allows clicking on minions to view details and manual refresh of the list.
 *
 * @component
 */
import { ref, onMounted, onUnmounted } from 'vue';
import { callMCPThrone, cabinetEvents, type MinionEventNotification } from '../api/cabinet';
import { AVAILABLE_MINION_CLIENTS, type MinionClient } from '@minions/mcp-types';
import ListHeader from './ListHeader.vue';
import StateDisplay from './StateDisplay.vue';

/**
 * Minion data structure
 */
interface Minion {
  id: string;
  client: MinionClient;
  status: 'idle' | 'working' | 'blocked' | 'dead';
  wingName: string;
  createdAt?: number;
}

/**
 * Props:
 * @prop {string} wingName - Name of the wing to load minions from
 */
const props = defineProps<{
  wingName: string;
}>();

/**
 * Events:
 * @event select - Emitted when a minion card is clicked, passes minion ID
 */
defineEmits<{
  select: [minionId: string];
}>();

const minions = ref<Minion[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

let unsubscribe: (() => void) | null = null;

/**
 * Load minions from Cabinet MCP server
 * Called on mount and when refresh button is clicked
 */
async function loadMinions() {
  try {
    loading.value = true;
    error.value = null;
    const result = await callMCPThrone('minions', {
      action: 'list',
      wingName: props.wingName
    });
    minions.value = 'minions' in result ? result.minions : [];
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load minions';
  } finally {
    loading.value = false;
  }
}

/**
 * Handle minion events from the server
 */
function handleMinionEvent(event: MinionEventNotification) {
  if (event.type === 'minion_spawned') {
    // Add new minion to the list
    minions.value = [...minions.value, {
      id: event.minionId,
      client: event.client as MinionClient,
      status: event.status as Minion['status'],
      wingName: event.wingName,
    }];
  } else if (event.type === 'minion_killed') {
    // Remove killed minion from list
    minions.value = minions.value.filter(m => m.id !== event.minionId);
  } else if (event.type === 'minion_status_changed') {
    // Update minion status
    minions.value = minions.value.map(m =>
      m.id === event.minionId
        ? { ...m, status: event.status as Minion['status'] }
        : m
    );
  }
}

/**
 * Format minion client for display
 * @param client - Raw minion client string
 * @returns Human-readable client name
 */
function formatClient(client: MinionClient): string {
  const clientMeta = AVAILABLE_MINION_CLIENTS.find(c => c.type === client);
  return clientMeta?.displayName || client;
}

/**
 * Format minion status for display
 * @param status - Raw status string
 * @returns Capitalized status
 */
function formatStatus(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/**
 * Format timestamp as localized date/time string
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Formatted date string
 */
function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

onMounted(async () => {
  // Load initial minion list
  await loadMinions();

  // Subscribe to minion events for this wing using filter
  unsubscribe = cabinetEvents.subscribe<MinionEventNotification>(
    {
      type: ['minion_spawned', 'minion_killed', 'minion_status_changed'],
      wingName: props.wingName,
    },
    handleMinionEvent
  );
});

onUnmounted(() => {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
});

// Expose loadMinions for parent components
defineExpose({ loadMinions });
</script>

<style scoped>
.minion-list {
  margin-top: 20px;
}

.minions-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}

.minion-card {
  background: white;
  border: 2px solid #ddd;
  border-radius: 8px;
  padding: 16px;
  cursor: pointer;
  transition: all 0.2s;
}

.minion-card:hover {
  border-color: #1976d2;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.minion-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.minion-id {
  font-family: monospace;
  font-size: 14px;
  font-weight: 600;
  color: #333;
}

.minion-client {
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

.client-claude-code {
  background: #e3f2fd;
  color: #1976d2;
}

.client-anthropic-agentic {
  background: #f3e5f5;
  color: #7b1fa2;
}

.client-opencode {
  background: #e8f5e9;
  color: #2e7d32;
}

.client-code-puppy {
  background: #fff3e0;
  color: #e65100;
}

.minion-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 8px;
}

.status-indicator {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.status-idle {
  background: #f5f5f5;
  color: #666;
}

.status-idle .status-indicator {
  background: #999;
}

.status-working {
  background: #e8f5e9;
  color: #2e7d32;
}

.status-working .status-indicator {
  background: #4caf50;
  animation: pulse 2s infinite;
}

.status-blocked {
  background: #fff3e0;
  color: #e65100;
}

.status-blocked .status-indicator {
  background: #ff9800;
}

.status-dead {
  background: #ffebee;
  color: #c62828;
}

.status-dead .status-indicator {
  background: #f44336;
}

.minion-meta {
  font-size: 12px;
  color: #666;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}
</style>
