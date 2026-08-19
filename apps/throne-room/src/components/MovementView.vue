<template>
  <div class="movement-view">
    <h2>Movement</h2>

    <div class="selectors">
      <label class="field">
        <span>Wing</span>
        <select v-model="selectedWing" :disabled="loadingWings">
          <option v-for="wing in wings" :key="wing.name" :value="wing.name">{{ wing.name }}</option>
        </select>
      </label>

      <label class="field">
        <span>Repo</span>
        <select v-model="selectedRepo" :disabled="repoOptions.length === 0">
          <option v-for="repo in repoOptions" :key="repo" :value="repo">{{ repo }}</option>
        </select>
      </label>

      <button
        type="button"
        class="status-btn"
        @click="checkStatus"
        :disabled="!selectedWing || !selectedRepo || checking"
      >
        {{ checking ? 'Checking…' : 'Check Status' }}
      </button>

      <button
        type="button"
        class="diff-btn"
        @click="showDiff"
        :disabled="!selectedWing || !selectedRepo || diffing"
      >
        {{ diffing ? 'Loading diff…' : 'Show Diff' }}
      </button>
    </div>

    <div v-if="statusError" class="error-box">{{ statusError }}</div>

    <div v-if="status" class="status-box">
      <div class="status-row">
        <span class="status-label">branch</span>
        <code>{{ status.branch }}</code>
      </div>
      <div class="status-row">
        <span class="status-label">isMovementBranch</span>
        <code>{{ status.isMovementBranch }}</code>
      </div>
      <div class="status-row">
        <span class="status-label">isDirty</span>
        <code>{{ status.isDirty }}</code>
      </div>
    </div>

    <div v-if="diffError" class="error-box">{{ diffError }}</div>

    <pre v-if="diff !== null" class="diff-box">{{ diff }}</pre>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { callMCPThrone, callMCPHenchery, callMCPThroneRaw } from '../api/cabinet';

interface WingSummary {
  name: string;
  extraWork: Array<{ name: string }>;
}

interface MovementStatus {
  branch: string;
  isMovementBranch: boolean;
  isDirty: boolean;
}

const wings = ref<WingSummary[]>([]);
const loadingWings = ref(true);
const selectedWing = ref('');
const selectedRepo = ref('local');
const checking = ref(false);
const status = ref<MovementStatus | null>(null);
const statusError = ref<string | null>(null);
const diffing = ref(false);
const diff = ref<string | null>(null);
const diffError = ref<string | null>(null);

const repoOptions = computed(() => {
  const wing = wings.value.find(w => w.name === selectedWing.value);
  if (!wing) return [];
  return ['local', ...wing.extraWork.map(entry => entry.name)];
});

watch(repoOptions, (options) => {
  if (!options.includes(selectedRepo.value)) {
    selectedRepo.value = options[0] ?? 'local';
  }
});

async function loadWings() {
  try {
    loadingWings.value = true;
    const state = await callMCPThrone('lair_get_state', {});
    wings.value = state.wings.map(w => ({ name: w.name, extraWork: w.extraWork ?? [] }));
    if (wings.value.length > 0 && !selectedWing.value) {
      selectedWing.value = wings.value[0].name;
    }
  } catch (e) {
    statusError.value = e instanceof Error ? e.message : 'Failed to load wings';
  } finally {
    loadingWings.value = false;
  }
}

async function checkStatus() {
  if (!selectedWing.value || !selectedRepo.value) return;
  try {
    checking.value = true;
    statusError.value = null;
    status.value = await callMCPHenchery<MovementStatus>(selectedWing.value, 'movement', {
      action: 'status',
      repo: selectedRepo.value,
    });
  } catch (e) {
    statusError.value = e instanceof Error ? e.message : 'Failed to check status';
    status.value = null;
  } finally {
    checking.value = false;
  }
}

async function showDiff() {
  if (!selectedWing.value || !selectedRepo.value) return;
  try {
    diffing.value = true;
    diffError.value = null;
    const result = await callMCPThroneRaw<{ diff: string }>('movement', {
      action: 'diff',
      wing: selectedWing.value,
      repo: selectedRepo.value,
    });
    diff.value = result.diff;
  } catch (e) {
    diffError.value = e instanceof Error ? e.message : 'Failed to load diff';
    diff.value = null;
  } finally {
    diffing.value = false;
  }
}

onMounted(loadWings);
</script>

<style scoped>
.movement-view {
  padding: 24px;
  max-width: 720px;
}

h2 {
  margin: 0 0 16px 0;
}

.selectors {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.85em;
  color: #555;
}

.field select {
  padding: 6px 10px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 13px;
  min-width: 140px;
}

.status-btn {
  padding: 7px 14px;
  background: #1976d2;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.status-btn:hover:not(:disabled) {
  background: #1565c0;
}

.status-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.diff-btn {
  padding: 7px 14px;
  background: #455a64;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.diff-btn:hover:not(:disabled) {
  background: #37474f;
}

.diff-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.diff-box {
  margin-top: 16px;
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 12px;
  border-radius: 4px;
  font-size: 12px;
  overflow-x: auto;
  white-space: pre;
}

.error-box {
  margin-top: 16px;
  background: #ffebee;
  color: #d32f2f;
  padding: 10px 12px;
  border-radius: 4px;
  font-size: 13px;
}

.status-box {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: #f9f9f9;
  padding: 12px;
  border-radius: 4px;
}

.status-row {
  display: flex;
  gap: 8px;
  font-size: 13px;
}

.status-label {
  font-weight: 600;
  min-width: 140px;
  color: #333;
}
</style>
