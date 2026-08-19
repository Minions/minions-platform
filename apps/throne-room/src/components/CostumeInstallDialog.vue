<template>
  <div class="modal-overlay" @click.self="$emit('cancel')">
    <div class="modal">
      <h2>Install Costume</h2>

      <form @submit.prevent="handleSubmit">
        <div class="form-group">
          <label>Wing:</label>
          <select v-model="wingName" required :disabled="loadingWings">
            <option v-if="loadingWings" value="">Loading wings...</option>
            <option v-else-if="wings.length === 0" value="">No wings available</option>
            <option
              v-else
              v-for="wing in wings"
              :key="wing.name"
              :value="wing.name"
            >
              {{ wing.name }}
            </option>
          </select>
        </div>

        <div class="form-group">
          <label>Costume Path:</label>
          <input
            v-model="costumePath"
            type="text"
            required
            placeholder="costumes/my-costume"
          />
          <p class="hint">
            Path relative to work/local (e.g., "costumes/my-costume"). The costume must be built first.
          </p>
        </div>

        <div class="form-group">
          <label>Install As:</label>
          <input
            v-model="installedName"
            type="text"
            required
            placeholder="my-costume"
            pattern="[a-zA-Z0-9_-]+"
            title="Only letters, numbers, hyphens, and underscores allowed"
          />
          <p class="hint">
            Name to install the costume as in the closet
          </p>
        </div>

        <div v-if="error" class="error">
          {{ error }}
        </div>

        <div v-if="success" class="success">
          {{ success }}
        </div>

        <div v-if="result" class="result">
          <p><strong>Closet link:</strong> {{ result.closetLink }}</p>
          <p v-if="result.commandsLink"><strong>Commands link:</strong> {{ result.commandsLink }}</p>
          <p v-if="result.agentsLink"><strong>Agents link:</strong> {{ result.agentsLink }}</p>
          <p v-if="result.skillsLink"><strong>Skills link:</strong> {{ result.skillsLink }}</p>
        </div>

        <div class="actions">
          <button type="button" @click="$emit('cancel')" :disabled="loading">
            {{ result ? 'Close' : 'Cancel' }}
          </button>
          <button type="submit" :disabled="loading || !!result">
            {{ loading ? 'Installing...' : 'Install' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { callMCPThrone, callMCPLairRaw } from '../api/cabinet';
import type { CostumesInstallResult, WingSummary } from '@minions/mcp-types';

const emit = defineEmits<{
  cancel: [];
  installed: [result: CostumesInstallResult];
}>();

const wingName = ref('');
const costumePath = ref('');
const installedName = ref('');
const loading = ref(false);
const loadingWings = ref(true);
const error = ref<string | null>(null);
const success = ref<string | null>(null);
const result = ref<CostumesInstallResult | null>(null);
const wings = ref<WingSummary[]>([]);

async function loadWings() {
  try {
    loadingWings.value = true;
    const state = await callMCPThrone('lair_get_state', {});
    wings.value = state.wings;
    // Set default to first wing if available
    if (state.wings.length > 0 && !wingName.value) {
      wingName.value = state.wings[0].name;
    }
  } catch (e) {
    console.error('Failed to load wings:', e);
    wings.value = [];
  } finally {
    loadingWings.value = false;
  }
}

onMounted(loadWings);

async function handleSubmit() {
  error.value = null;
  success.value = null;
  result.value = null;

  if (!wingName.value) {
    error.value = 'Please select a wing';
    return;
  }

  if (!costumePath.value) {
    error.value = 'Costume path is required';
    return;
  }

  if (!installedName.value) {
    error.value = 'Install name is required';
    return;
  }

  try {
    loading.value = true;

    const installResult = await callMCPLairRaw<CostumesInstallResult>('costumes', {
      action: 'install',
      wing: wingName.value,
      costumePath: costumePath.value,
      installedName: installedName.value
    });

    result.value = installResult;
    success.value = installResult.message;

    emit('installed', installResult);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to install costume';
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: white;
  padding: 24px;
  border-radius: 8px;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
  min-width: 450px;
  max-width: 600px;
}

h2 {
  margin: 0 0 20px 0;
  color: #333;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  margin-bottom: 6px;
  font-weight: 500;
  color: #555;
}

.form-group input,
.form-group select {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 14px;
  font-family: inherit;
}

.form-group input:focus,
.form-group select:focus {
  outline: none;
  border-color: #0066cc;
}

.hint {
  margin: 6px 0 0 0;
  font-size: 12px;
  color: #666;
  font-style: italic;
}

.error {
  padding: 10px;
  background: #fee;
  border: 1px solid #fcc;
  border-radius: 4px;
  color: #c33;
  margin-bottom: 16px;
}

.success {
  padding: 10px;
  background: #efe;
  border: 1px solid #cfc;
  border-radius: 4px;
  color: #3c3;
  margin-bottom: 16px;
}

.result {
  padding: 10px;
  background: #f5f5f5;
  border: 1px solid #ddd;
  border-radius: 4px;
  margin-bottom: 16px;
  font-size: 13px;
}

.result p {
  margin: 4px 0;
  word-break: break-all;
}

.actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

button {
  padding: 8px 16px;
  border: 1px solid #ddd;
  border-radius: 4px;
  background: white;
  cursor: pointer;
  font-size: 14px;
}

button:hover:not(:disabled) {
  background: #f5f5f5;
}

button[type="submit"] {
  background: #0066cc;
  color: white;
  border-color: #0066cc;
}

button[type="submit"]:hover:not(:disabled) {
  background: #0052a3;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
