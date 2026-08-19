<template>
  <ConfirmationDialog
    title="Kill Minion"
    confirmLabel="Kill Minion"
    confirmingLabel="Killing..."
    :processing="killing"
    :error="error"
    variant="danger"
    @confirm="handleKill"
    @cancel="$emit('cancel')"
  >
    <p>Are you sure you want to kill minion <strong>{{ minionId }}</strong>?</p>
    <p>The conversation will be saved to <code>private/global/conversations/</code></p>
    <p class="warning">This action cannot be undone.</p>
  </ConfirmationDialog>
</template>

<script setup lang="ts">
/**
 * KillMinionDialog Component
 *
 * Confirmation dialog for killing a minion.
 * Displays warning, calls Cabinet MCP server to kill the minion,
 * and returns the path where the conversation dump was saved.
 *
 * @component
 */
import { ref } from 'vue';
import { callMCPConductor } from '../api/cabinet';
import type { MinionsKillResult } from '@minions/mcp-types';
import ConfirmationDialog from './ConfirmationDialog.vue';

/**
 * Props:
 * @prop {string} minionId - ID of the minion to kill
 */
const props = defineProps<{
  minionId: string;
}>();

/**
 * Events:
 * @event killed - Emitted when minion successfully killed, passes dump path
 * @event cancel - Emitted when user cancels the kill operation
 */
const emit = defineEmits<{
  killed: [dumpPath: string];
  cancel: [];
}>();

const killing = ref(false);
const error = ref<string | null>(null);

/**
 * Handle kill confirmation
 * Calls MCP server to kill the minion and saves conversation dump
 */
async function handleKill() {
  try {
    killing.value = true;
    error.value = null;

    const result = await callMCPConductor('minions', {
      action: 'kill',
      minionId: props.minionId
    });

    emit('killed', (result as MinionsKillResult).dumpPath ?? '');
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to kill minion';
  } finally {
    killing.value = false;
  }
}
</script>

<style scoped>
.warning {
  color: #d32f2f;
  font-weight: 600;
}

p {
  margin: 12px 0;
  line-height: 1.5;
}

code {
  background: #f5f5f5;
  padding: 2px 6px;
  border-radius: 3px;
  font-family: monospace;
  font-size: 13px;
}
</style>
