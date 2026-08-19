/**
 * Composable for subscribing to mission events via MCP notifications
 *
 * Uses the global missionEvents emitter from cabinet.ts to receive
 * real-time mission event updates without polling.
 */

import { ref, onMounted, onUnmounted, type Ref } from 'vue';
import { callMCPThrone, missionEvents } from '../api/cabinet';
import type { MissionEventRecord, MissionEventsResult, MissionRunStatus } from '@minions/mcp-types';

/**
 * Subscribe to mission events for a specific mission run
 *
 * @param missionRunId - The ID of the mission to subscribe to
 * @returns Reactive refs for events and status, plus control functions
 */
export function useMissionEvents(missionRunId: Ref<string>) {
  const events = ref<MissionEventRecord[]>([]);
  const status = ref<MissionRunStatus>('running');
  const error = ref<string | null>(null);
  const isLoading = ref(true);

  let unsubscribe: (() => void) | null = null;

  async function loadInitialEvents() {
    try {
      isLoading.value = true;
      const result = await callMCPThrone('missions', { action: 'events', missionRunId: missionRunId.value }) as MissionEventsResult;
      events.value = result.events;
      status.value = result.status;
      error.value = null;
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to load events';
    } finally {
      isLoading.value = false;
    }
  }

  function handleEvent(event: MissionEventRecord) {
    events.value = [...events.value, event];

    // Update status based on terminal events
    if (event.type === 'completed') {
      status.value = 'completed';
    } else if (event.type === 'failed') {
      status.value = 'failed';
    } else if (event.type === 'cancelled') {
      status.value = 'cancelled';
    }
  }

  onMounted(async () => {
    // Load initial events (catches any missed before subscription)
    await loadInitialEvents();

    // Subscribe to live updates
    unsubscribe = missionEvents.subscribe(missionRunId.value, handleEvent);
  });

  onUnmounted(() => {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  });

  return {
    events,
    status,
    error,
    isLoading,
    refresh: loadInitialEvents,
  };
}
