<template>
  <div class="mission-list">
    <ListHeader :loading="loading" @refresh="loadMissions">
      Missions
    </ListHeader>

    <StateDisplay
      :loading="loading"
      :error="error"
      :empty="missions.length === 0"
      loading-text="Loading missions..."
    >
      <template #empty>
        <p>No missions available.</p>
        <p>Add a costume with missions to the closet.</p>
      </template>

      <div class="missions-grid">
        <div
          v-for="mission in missions"
          :key="`${mission.costume}/${mission.name}`"
          class="mission-card"
          :class="{ 'mission-card--disabled': mission.runnable === false }"
          @click="mission.runnable !== false && $emit('select', mission)"
        >
          <div class="mission-header">
            <div class="mission-name">{{ mission.name }}</div>
            <div class="mission-badges">
              <span class="mission-costume">{{ mission.costume }}</span>
              <span v-if="mission.isLegacy" class="mission-legacy">Non-deterministic</span>
              <span v-if="mission.runnable === false" class="mission-unrunnable">Un-runnable</span>
            </div>
          </div>

          <div v-if="mission.runnable === false && mission.unrunnableReason" class="mission-unrunnable-reason">
            {{ mission.unrunnableReason }}
          </div>

          <div v-if="mission.description" class="mission-description">
            {{ mission.description }}
          </div>

          <div v-if="mission.argsSchema" class="mission-args">
            <span class="args-label">Args:</span>
            <span
              v-for="arg in Object.keys(mission.argsSchema.properties || {})"
              :key="arg"
              class="arg-chip"
              :class="{ required: isRequired(mission, arg) }"
            >
              {{ arg }}
            </span>
          </div>
        </div>
      </div>
    </StateDisplay>
  </div>
</template>

<script setup lang="ts">
/**
 * MissionList Component
 *
 * Displays a grid of available missions from the closet.
 * Shows mission name, description, costume, and whether it's a non-deterministic mission.
 * Allows clicking on missions to start them.
 *
 * @component
 */
import { ref, onMounted } from 'vue';
import { callMCPConductor } from '../api/cabinet';
import type { MissionSummary_, MissionListResult } from '@minions/mcp-types';
import ListHeader from './ListHeader.vue';
import StateDisplay from './StateDisplay.vue';

/**
 * Props:
 * @prop {string} wingName - Name of the wing to load missions from
 */
const props = defineProps<{
  wingName: string;
}>();

/**
 * Events:
 * @event select - Emitted when a mission card is clicked, passes mission summary
 */
defineEmits<{
  select: [mission: MissionSummary_];
}>();

const missions = ref<MissionSummary_[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

/**
 * Load missions from Cabinet MCP server
 */
async function loadMissions() {
  try {
    loading.value = true;
    error.value = null;
    const result = await callMCPConductor('missions', {
      action: 'list',
      wingName: props.wingName
    });
    missions.value = (result as MissionListResult).missions;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load missions';
  } finally {
    loading.value = false;
  }
}

/**
 * Check if an argument is required
 */
function isRequired(mission: MissionSummary_, argName: string): boolean {
  return mission.argsSchema?.required?.includes(argName) ?? false;
}

// Load missions once on mount - missions are static files in the closet
// and don't change during runtime. Manual refresh is available via header.
onMounted(() => {
  loadMissions();
});

defineExpose({ loadMissions });
</script>

<style scoped>
.mission-list {
  margin-top: 20px;
}

.missions-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
}

.mission-card {
  background: white;
  border: 2px solid #ddd;
  border-radius: 8px;
  padding: 16px;
  cursor: pointer;
  transition: all 0.2s;
}

.mission-card:hover {
  border-color: #7b1fa2;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.mission-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 8px;
  gap: 8px;
}

.mission-name {
  font-size: 16px;
  font-weight: 600;
  color: #333;
}

.mission-badges {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.mission-costume {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  background: #e3f2fd;
  color: #1976d2;
}

.mission-legacy {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  background: #fff3e0;
  color: #e65100;
}

.mission-unrunnable {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  background: #ffebee;
  color: #c62828;
}

.mission-unrunnable-reason {
  font-size: 13px;
  color: #c62828;
  margin-bottom: 8px;
  line-height: 1.4;
  padding: 6px 10px;
  background: #ffebee;
  border-radius: 4px;
}

.mission-card--disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.mission-card--disabled:hover {
  border-color: #ddd;
  box-shadow: none;
}

.mission-description {
  font-size: 14px;
  color: #666;
  margin-bottom: 12px;
  line-height: 1.4;
}

.mission-args {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.args-label {
  font-size: 12px;
  color: #999;
  font-weight: 500;
}

.arg-chip {
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 12px;
  font-family: monospace;
  background: #f5f5f5;
  color: #666;
}

.arg-chip.required {
  background: #fce4ec;
  color: #c2185b;
}

.arg-chip.required::after {
  content: '*';
  margin-left: 2px;
}
</style>
