<!--
/**
 * RunningMissions Component
 *
 * Displays a list of running and recently completed missions.
 * Updates in real-time via MCP notifications (no polling).
 * Allows clicking on a mission to view its event stream.
 *
 * @component
 * @emits {select} - Emitted when a mission is selected
 */
-->
<template>
  <div class="running-missions">
    <div class="header">
      <h3>Running Missions</h3>
      <span v-if="runningCount > 0" class="running-count">{{ runningCount }}</span>
    </div>

    <div v-if="missions.size === 0" class="empty-state">
      No missions running
    </div>

    <div v-else class="missions-list">
      <div
        v-for="mission in sortedMissions"
        :key="mission.missionRunId"
        :class="['mission-item', `status-${mission.status}`]"
        @click="$emit('select', mission)"
      >
        <div class="mission-info">
          <span class="mission-name">{{ mission.missionName }}</span>
          <span class="costume-badge">{{ mission.costume }}</span>
        </div>
        <div class="mission-meta">
          <span class="wing-name">{{ mission.wingName }}</span>
          <span :class="['status-badge', `status-${mission.status}`]">
            {{ formatStatus(mission.status) }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { callMCPThrone, missionEvents, type MissionEventNotification } from '../api/cabinet';
import type { MissionRunStatus, MissionsRunningResult } from '@minions/mcp-types';

export interface TrackedMission {
  missionRunId: string;
  missionName: string;
  costume: string;
  wingName: string;
  status: MissionRunStatus;
  startedAt: number;
}

defineEmits<{
  select: [mission: TrackedMission];
}>();

const missions = ref<Map<string, TrackedMission>>(new Map());

let unsubscribe: (() => void) | null = null;

/**
 * Count of running missions
 */
const runningCount = computed(() => {
  return Array.from(missions.value.values()).filter(m => m.status === 'running').length;
});

/**
 * Sorted missions - running first, then by start time (newest first)
 */
const sortedMissions = computed(() => {
  const list = Array.from(missions.value.values());
  return list.sort((a, b) => {
    // Running missions first
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (a.status !== 'running' && b.status === 'running') return 1;
    // Then by start time (newest first)
    return b.startedAt - a.startedAt;
  });
});

/**
 * Handle mission event notification
 */
function handleEvent(notification: MissionEventNotification) {
  console.log('[RunningMissions] Received event:', notification);
  const { missionRunId, missionName, costume, wingName, event } = notification;

  // Get or create the tracked mission
  let tracked = missions.value.get(missionRunId);
  if (!tracked) {
    console.log('[RunningMissions] Creating new tracked mission:', missionRunId);
    tracked = {
      missionRunId,
      missionName,
      costume,
      wingName,
      status: 'running',
      startedAt: event.timestamp,
    };
    missions.value.set(missionRunId, tracked);
  }

  // Update status based on event type
  if (event.type === 'completed') {
    tracked.status = 'completed';
  } else if (event.type === 'failed') {
    tracked.status = 'failed';
  } else if (event.type === 'cancelled') {
    tracked.status = 'cancelled';
  }

  // Trigger reactivity
  missions.value = new Map(missions.value);
}

/**
 * Format status for display
 */
function formatStatus(status: MissionRunStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

onMounted(async () => {
  console.log('[RunningMissions] Mounted, loading existing missions');
  try {
    const result = await callMCPThrone('missions', { action: 'running' });
    const runningMissions = (result as MissionsRunningResult).missions;
    for (const m of runningMissions) {
      missions.value.set(m.missionRunId, {
        missionRunId: m.missionRunId,
        missionName: m.missionName,
        costume: m.costume,
        wingName: m.wingName,
        status: m.status,
        startedAt: m.startedAt,
      });
    }
    if (runningMissions.length > 0) {
      missions.value = new Map(missions.value);
    }
  } catch (e) {
    console.error('[RunningMissions] Failed to load existing missions:', e);
  }

  // Subscribe to real-time events for updates
  unsubscribe = missionEvents.subscribeAll(handleEvent);
  console.log('[RunningMissions] Subscribed');
});

onUnmounted(() => {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
});
</script>

<style scoped>
.running-missions {
  background: white;
  border: 1px solid #ddd;
  border-radius: 8px;
  padding: 16px;
}

.header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.header h3 {
  margin: 0;
  color: #333;
  font-size: 14px;
  font-weight: 600;
}

.running-count {
  background: #7b1fa2;
  color: white;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
}

.empty-state {
  color: #999;
  font-size: 14px;
  text-align: center;
  padding: 20px;
}

.missions-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mission-item {
  padding: 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
}

.mission-item:hover {
  background: #f5f5f5;
  border-color: #bbb;
}

.mission-item.status-running {
  border-left: 3px solid #2e7d32;
}

.mission-item.status-completed {
  border-left: 3px solid #1976d2;
}

.mission-item.status-failed {
  border-left: 3px solid #c62828;
}

.mission-item.status-cancelled {
  border-left: 3px solid #e65100;
}

.mission-info {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.mission-name {
  font-weight: 600;
  color: #333;
}

.costume-badge {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  background: #e3f2fd;
  color: #1976d2;
}

.mission-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.wing-name {
  font-size: 12px;
  color: #666;
}

.status-badge {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
}

.status-badge.status-running {
  background: #e8f5e9;
  color: #2e7d32;
}

.status-badge.status-completed {
  background: #e3f2fd;
  color: #1976d2;
}

.status-badge.status-failed {
  background: #ffebee;
  color: #c62828;
}

.status-badge.status-cancelled {
  background: #fff3e0;
  color: #e65100;
}
</style>
