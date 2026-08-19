<template>
  <div class="work-mappings-editor">
    <h4>Work Directories</h4>

    <!-- Current mappings -->
    <div class="current-mappings">
      <div class="mapping-row fixed">
        <span class="mapping-name">local</span>
        <code class="mapping-path">{{ wing.workLocal || '—' }}</code>
        <span class="mapping-tag">primary</span>
      </div>
      <div v-if="wing.workGlobal" class="mapping-row fixed">
        <span class="mapping-name">global</span>
        <code class="mapping-path">{{ wing.workGlobal }}</code>
        <span class="mapping-tag">fixed</span>
      </div>
      <div
        v-for="entry in wing.extraWork"
        :key="entry.name"
        class="mapping-row extra"
      >
        <span class="mapping-name">{{ entry.name }}</span>
        <code class="mapping-path">{{ entry.path }}</code>
        <button
          class="remove-btn"
          @click="confirmRemove(entry.name)"
          :disabled="saving"
          title="Remove this work directory"
        >✕</button>
      </div>
    </div>

    <!-- Add new mapping -->
    <div class="add-section">
      <h5>Add Work Directory</h5>
      <div class="add-form">
        <input
          v-model="newEntry.name"
          type="text"
          placeholder="dir-name"
          :disabled="saving || loadingRepos"
          class="add-name"
        />
        <select v-model="newEntry.repo" :disabled="saving || loadingRepos" class="add-repo">
          <option value="">— select repo —</option>
          <option v-for="repo in availableRepos" :key="repo" :value="repo">{{ repo }}</option>
        </select>
        <input
          v-model="newEntry.branch"
          type="text"
          placeholder="branch"
          :disabled="saving"
          class="add-branch"
        />
        <input
          v-model="newEntry.subdir"
          type="text"
          placeholder="subdir (optional)"
          :disabled="saving"
          class="add-subdir"
        />
        <button
          type="button"
          class="add-btn"
          @click="addMapping"
          :disabled="saving || !newEntry.name.trim() || !newEntry.repo"
        >
          Add
        </button>
      </div>
      <span v-if="addError" class="error">{{ addError }}</span>
    </div>

    <div v-if="successMessage" class="success-box">{{ successMessage }}</div>
    <div v-if="saveError" class="error-box">{{ saveError }}</div>

    <!-- Remove confirmation -->
    <div v-if="removingName" class="confirm-box">
      <p>Remove work directory <strong>{{ removingName }}</strong>?</p>
      <div class="confirm-actions">
        <button class="confirm-remove-btn" @click="executeRemove" :disabled="saving">Remove</button>
        <button @click="removingName = null" :disabled="saving">Cancel</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { callMCPThrone, callMCPConductor } from '../api/cabinet';
import type { WingsUpdateResult } from '@minions/mcp-types';
import type { Wing } from '../types/wing';

const props = defineProps<{
  wing: Wing;
}>();

const emit = defineEmits<{
  updated: [wing: Wing];
}>();

const availableRepos = ref<string[]>([]);
const loadingRepos = ref(true);
const saving = ref(false);
const saveError = ref<string | null>(null);
const successMessage = ref<string | null>(null);
const addError = ref<string | null>(null);
const removingName = ref<string | null>(null);

const newEntry = reactive({ name: '', repo: '', branch: 'main', subdir: '' });

async function loadAvailableRepos() {
  try {
    loadingRepos.value = true;
    const state = await callMCPThrone('lair_get_state', {});
    availableRepos.value = state.availableWorkRepos;
    if (state.availableWorkRepos.length > 0 && !newEntry.repo) {
      newEntry.repo = state.availableWorkRepos[0];
    }
  } catch (e) {
    console.error('Failed to load repos:', e);
  } finally {
    loadingRepos.value = false;
  }
}

onMounted(loadAvailableRepos);

function confirmRemove(name: string) {
  removingName.value = name;
  saveError.value = null;
  successMessage.value = null;
}

async function executeRemove() {
  if (!removingName.value) return;
  const name = removingName.value;
  removingName.value = null;

  try {
    saving.value = true;
    saveError.value = null;
    successMessage.value = null;

    const result = await callMCPConductor('wings', {
      action: 'update',
      name: props.wing.name,
      removeWork: [name],
    });

    successMessage.value = `Removed work directory "${name}"`;
    emit('updated', (result as WingsUpdateResult).wing);
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : 'Failed to remove work directory';
  } finally {
    saving.value = false;
  }
}

async function addMapping() {
  addError.value = null;
  const name = newEntry.name.trim();

  if (!name) { addError.value = 'Name is required'; return; }
  if (!/^[a-z0-9-]+$/.test(name)) { addError.value = 'Name must be lowercase letters, numbers, and hyphens only'; return; }
  if (name === 'local' || name === 'global') { addError.value = '"local" and "global" are reserved names'; return; }
  if (!newEntry.repo) { addError.value = 'Repository is required'; return; }

  try {
    saving.value = true;
    saveError.value = null;
    successMessage.value = null;

    const workEntry: { repo: string; branch: string; subdir?: string } = {
      repo: newEntry.repo,
      branch: newEntry.branch || 'main',
    };
    if (newEntry.subdir.trim()) workEntry.subdir = newEntry.subdir.trim();

    const result = await callMCPConductor('wings', {
      action: 'update',
      name: props.wing.name,
      addWork: { [name]: workEntry },
    });

    successMessage.value = `Added work directory "${name}"`;
    newEntry.name = '';
    newEntry.branch = 'main';
    newEntry.subdir = '';
    emit('updated', (result as WingsUpdateResult).wing);
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : 'Failed to add work directory';
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.work-mappings-editor {
  padding: 0;
}

h4 {
  margin: 0 0 12px 0;
  color: #555;
  font-size: 0.9em;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

h5 {
  margin: 0 0 8px 0;
  font-size: 0.85em;
  color: #666;
  font-weight: 600;
}

.current-mappings {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 16px;
}

.mapping-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  background: #f9f9f9;
}

.mapping-row.fixed {
  border-left: 3px solid #1976d2;
}

.mapping-row.extra {
  border-left: 3px solid #4caf50;
}

.mapping-name {
  font-weight: 600;
  font-family: monospace;
  font-size: 0.9em;
  min-width: 80px;
  color: #333;
}

.mapping-path {
  flex: 1;
  font-size: 0.85em;
  background: transparent;
  padding: 2px 4px;
  color: #555;
  word-break: break-all;
}

.mapping-tag {
  font-size: 11px;
  color: #888;
  font-style: italic;
}

.remove-btn {
  padding: 2px 6px;
  background: #ffebee;
  color: #d32f2f;
  border: 1px solid #ffcdd2;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  flex-shrink: 0;
}

.remove-btn:hover:not(:disabled) {
  background: #ffcdd2;
}

.add-section {
  border-top: 1px solid #eee;
  padding-top: 12px;
  margin-bottom: 12px;
}

.add-form {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}

.add-name {
  width: 120px;
  padding: 6px 10px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 13px;
}

.add-repo {
  flex: 1;
  min-width: 120px;
  padding: 6px 10px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 13px;
}

.add-branch {
  width: 90px;
  padding: 6px 10px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 13px;
}

.add-subdir {
  width: 130px;
  padding: 6px 10px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 13px;
}

.add-btn {
  padding: 6px 14px;
  background: #1976d2;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.add-btn:hover:not(:disabled) {
  background: #1565c0;
}

.add-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.error {
  display: block;
  color: #d32f2f;
  font-size: 12px;
  margin-top: 4px;
}

.error-box {
  background: #ffebee;
  color: #d32f2f;
  padding: 10px 12px;
  border-radius: 4px;
  font-size: 13px;
  margin-top: 8px;
}

.success-box {
  background: #e8f5e9;
  color: #2e7d32;
  padding: 10px 12px;
  border-radius: 4px;
  font-size: 13px;
  margin-top: 8px;
}

.confirm-box {
  background: #fff3e0;
  border: 1px solid #ffcc80;
  border-radius: 4px;
  padding: 12px;
  margin-top: 12px;
}

.confirm-box p {
  margin: 0 0 10px 0;
  font-size: 14px;
}

.confirm-actions {
  display: flex;
  gap: 8px;
}

.confirm-remove-btn {
  padding: 6px 14px;
  background: #d32f2f;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.confirm-remove-btn:hover:not(:disabled) {
  background: #b71c1c;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
