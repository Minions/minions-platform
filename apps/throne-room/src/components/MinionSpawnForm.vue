<!--
/**
 * MinionSpawnForm Component
 *
 * Provides a form for spawning new minions in a wing.
 * Dynamically displays all available minion client types from the shared mcp-types library.
 * Supports optional agent prompts for customizing minion behavior.
 *
 * @component
 * @emits {created} - Emitted when a minion is successfully created, passes minion data
 * @emits {cancel} - Emitted when the user cancels the form
 */
-->
<template>
  <div class="minion-spawn-form">
    <h3>Spawn Minion</h3>

    <form @submit.prevent="handleSubmit">
      <div class="form-field">
        <label for="minion-type">Minion Type</label>
        <select id="minion-type" v-model="minionClient" required>
          <option
            v-for="clientMeta in availableClients"
            :key="clientMeta.type"
            :value="clientMeta.type"
          >
            {{ clientMeta.displayName }}
          </option>
        </select>
        <small v-if="selectedClientMeta">{{ selectedClientMeta.description }}</small>
      </div>

      <div class="form-field">
        <label for="agent-prompt">Agent Prompt (Optional)</label>
        <textarea
          id="agent-prompt"
          v-model="agentPrompt"
          rows="8"
          placeholder="Enter custom agent prompt to customize minion behavior..."
        ></textarea>
        <small>Define custom behavior and capabilities for this minion.</small>
      </div>

      <div v-if="error" class="error">
        {{ error }}
      </div>

      <div class="form-actions">
        <button type="button" @click="$emit('cancel')" :disabled="spawning">
          Cancel
        </button>
        <button type="submit" :disabled="spawning">
          {{ spawning ? 'Spawning...' : 'Spawn Minion' }}
        </button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { callMCPConductor } from '../api/cabinet';
import { AVAILABLE_MINION_CLIENTS, type MinionClient, type MinionsResult, type MinionsParams } from '@minions/mcp-types';

/**
 * Component props
 */
const props = defineProps<{
  /** Name of the wing where the minion will be spawned */
  wingName: string;
}>();

const emit = defineEmits<{
  created: [minion: MinionsResult];
  cancel: [];
}>();

const availableClients = AVAILABLE_MINION_CLIENTS;
const minionClient = ref<MinionClient>('claude-code');
const agentPrompt = ref('');
const spawning = ref(false);
const error = ref<string | null>(null);

/**
 * Get metadata for the currently selected client
 */
const selectedClientMeta = computed(() => {
  return availableClients.find(c => c.type === minionClient.value);
});

/**
 * Handles form submission to spawn a new minion.
 * Calls the Cabinet MCP tool minions with action spawn and the appropriate parameters.
 * Resets the form and emits 'created' event on success.
 * Displays error message on failure.
 */
async function handleSubmit() {
  try {
    spawning.value = true;
    error.value = null;

    const args: Omit<Extract<MinionsParams, { action: 'spawn' }>, 'action'> = {
      wingName: props.wingName,
      client: minionClient.value
    };

    if (agentPrompt.value.trim()) {
      args.agentPrompt = agentPrompt.value;
    }

    const minion = await callMCPConductor('minions', { action: 'spawn', ...args });
    emit('created', minion);

    // Reset form
    minionClient.value = 'claude-code';
    agentPrompt.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to spawn minion';
  } finally {
    spawning.value = false;
  }
}
</script>

<style scoped>
.minion-spawn-form {
  background: white;
  border: 1px solid #ddd;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 20px;
}

.minion-spawn-form h3 {
  margin-top: 0;
  margin-bottom: 20px;
}

.form-field {
  margin-bottom: 20px;
}

.form-field label {
  display: block;
  margin-bottom: 8px;
  font-weight: 600;
  color: #333;
}

.form-field select,
.form-field textarea {
  width: 100%;
  padding: 10px;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 14px;
  font-family: inherit;
  box-sizing: border-box;
}

.form-field textarea {
  font-family: monospace;
  resize: vertical;
}

.form-field small {
  display: block;
  margin-top: 4px;
  color: #666;
  font-size: 12px;
}

.error {
  padding: 12px;
  background: #fee;
  border: 1px solid #fcc;
  border-radius: 4px;
  color: #c00;
  margin-bottom: 20px;
}

.form-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

.form-actions button {
  padding: 10px 20px;
  border: none;
  border-radius: 4px;
  font-weight: 600;
  cursor: pointer;
  font-size: 14px;
}

.form-actions button[type="button"] {
  background: #f5f5f5;
  color: #333;
}

.form-actions button[type="button"]:hover:not(:disabled) {
  background: #e0e0e0;
}

.form-actions button[type="submit"] {
  background: #1976d2;
  color: white;
}

.form-actions button[type="submit"]:hover:not(:disabled) {
  background: #1565c0;
}

.form-actions button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
