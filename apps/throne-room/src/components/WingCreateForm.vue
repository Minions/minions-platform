<template>
  <div class="wing-create-form">
    <h3>Build New Wing</h3>

    <form @submit.prevent="handleSubmit">
      <div class="form-group">
        <label for="name">Wing Name *</label>
        <input
          id="name"
          v-model="formData.name"
          type="text"
          placeholder="my-wing"
          :disabled="loading"
        />
        <span v-if="errors.name" class="error">{{ errors.name }}</span>
      </div>

      <div class="form-group">
        <label for="description">Description *</label>
        <textarea
          id="description"
          v-model="formData.description"
          placeholder="Purpose of this wing"
          :disabled="loading"
        />
        <span v-if="errors.description" class="error">{{ errors.description }}</span>
      </div>

      <div class="form-group">
        <label for="workLocalRepo">Primary Work Repository (work/local) *</label>
        <select
          id="workLocalRepo"
          v-model="formData.workLocalRepo"
          :disabled="loading || loadingRepos"
        >
          <option v-if="loadingRepos" value="">Loading repositories...</option>
          <option v-else-if="availableRepos.length === 0" value="">No repositories available</option>
          <option
            v-else
            v-for="repo in availableRepos"
            :key="repo"
            :value="repo"
          >
            {{ repo }}
          </option>
        </select>
      </div>

      <!-- Extra work directories -->
      <div class="form-group">
        <label>Additional Work Directories</label>
        <div class="extra-work-list">
          <div
            v-for="(entry, index) in extraWorkEntries"
            :key="index"
            class="extra-work-entry"
          >
            <input
              v-model="entry.name"
              type="text"
              placeholder="dir-name (e.g. open-source)"
              :disabled="loading"
              class="extra-work-name"
            />
            <select v-model="entry.repo" :disabled="loading || loadingRepos" class="extra-work-repo">
              <option value="">— repo —</option>
              <option v-for="repo in availableRepos" :key="repo" :value="repo">{{ repo }}</option>
            </select>
            <input
              v-model="entry.branch"
              type="text"
              placeholder="branch"
              :disabled="loading"
              class="extra-work-branch"
            />
            <input
              v-model="entry.subdir"
              type="text"
              placeholder="subdir (optional)"
              :disabled="loading"
              class="extra-work-subdir"
            />
            <button type="button" class="remove-btn" @click="removeExtraWork(index)" :disabled="loading">✕</button>
          </div>
        </div>
        <button type="button" class="add-extra-btn" @click="addExtraWork" :disabled="loading || loadingRepos">
          + Add Work Directory
        </button>
      </div>

      <div v-if="error" class="error-box">
        {{ error }}
      </div>

      <div class="form-actions">
        <button type="submit" :disabled="loading">
          {{ loading ? 'Building...' : 'Build Wing' }}
        </button>
        <button type="button" @click="$emit('cancel')" :disabled="loading">
          Cancel
        </button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { callMCPThrone, callMCPConductor } from '../api/cabinet';
import type { WingsResult } from '@minions/mcp-types';

const emit = defineEmits<{
  created: [wing: WingsResult];
  cancel: [];
}>();

const formData = reactive({
  name: '',
  description: '',
  workLocalRepo: ''
});

const errors = reactive({
  name: '',
  description: ''
});

interface ExtraWorkFormEntry {
  name: string;
  repo: string;
  branch: string;
  subdir: string;
}

const extraWorkEntries = ref<ExtraWorkFormEntry[]>([]);

function addExtraWork() {
  extraWorkEntries.value.push({ name: '', repo: availableRepos.value[0] || '', branch: 'main', subdir: '' });
}

function removeExtraWork(index: number) {
  extraWorkEntries.value.splice(index, 1);
}

const loading = ref(false);
const error = ref<string | null>(null);
const availableRepos = ref<string[]>([]);
const loadingRepos = ref(true);

async function loadAvailableRepos() {
  try {
    loadingRepos.value = true;
    const state = await callMCPThrone('lair_get_state', {});
    availableRepos.value = state.availableWorkRepos;
    // Set default to first repo if available
    if (state.availableWorkRepos.length > 0 && !formData.workLocalRepo) {
      formData.workLocalRepo = state.availableWorkRepos[0];
    }
  } catch (e) {
    console.error('Failed to load available repos:', e);
    // Fallback to empty list
    availableRepos.value = [];
  } finally {
    loadingRepos.value = false;
  }
}

onMounted(loadAvailableRepos);

function validate(): boolean {
  errors.name = '';
  errors.description = '';

  if (!formData.name.trim()) {
    errors.name = 'Wing name is required';
    return false;
  }

  if (!formData.description.trim()) {
    errors.description = 'Description is required';
    return false;
  }

  // Validate name format (kebab-case)
  if (!/^[a-z0-9-]+$/.test(formData.name)) {
    errors.name = 'Name must be lowercase with hyphens only';
    return false;
  }

  return true;
}

async function handleSubmit() {
  if (!validate()) return;

  try {
    loading.value = true;
    error.value = null;

    // Build extraWork map from entries (skip incomplete entries)
    const extraWork: Record<string, { repo: string; branch: string; subdir?: string }> = {};
    for (const entry of extraWorkEntries.value) {
      if (entry.name.trim() && entry.repo) {
        const workEntry: { repo: string; branch: string; subdir?: string } = { repo: entry.repo, branch: entry.branch || 'main' };
        if (entry.subdir.trim()) workEntry.subdir = entry.subdir.trim();
        extraWork[entry.name.trim()] = workEntry;
      }
    }

    const wing = await callMCPConductor('wings', {
      action: 'create',
      name: formData.name,
      description: formData.description,
      workLocalRepo: formData.workLocalRepo,
      ...(Object.keys(extraWork).length > 0 ? { extraWork } : {}),
    });

    emit('created', wing);

    // Reset form
    formData.name = '';
    formData.description = '';
    formData.workLocalRepo = availableRepos.value[0] || '';
    extraWorkEntries.value = [];
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to build wing';
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.wing-create-form {
  padding: 20px;
  background-color: #f9f9f9;
  border-radius: 8px;
}

.form-group {
  margin-bottom: 16px;
}

label {
  display: block;
  margin-bottom: 4px;
  font-weight: 600;
  color: #333;
}

input, textarea, select {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 14px;
}

textarea {
  min-height: 80px;
  resize: vertical;
}

.error {
  color: #d32f2f;
  font-size: 12px;
  margin-top: 4px;
  display: block;
}

.error-box {
  background-color: #ffebee;
  color: #d32f2f;
  padding: 12px;
  border-radius: 4px;
  margin-bottom: 16px;
}

.form-actions {
  display: flex;
  gap: 12px;
}

button {
  padding: 10px 20px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
}

button[type="submit"] {
  background-color: #1976d2;
  color: white;
}

button[type="submit"]:hover:not(:disabled) {
  background-color: #1565c0;
}

button[type="button"] {
  background-color: #e0e0e0;
  color: #333;
}

button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.extra-work-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 8px;
}

.extra-work-entry {
  display: flex;
  gap: 6px;
  align-items: center;
}

.extra-work-name {
  width: 140px;
  flex-shrink: 0;
}

.extra-work-repo {
  flex: 1;
}

.extra-work-branch {
  width: 100px;
  flex-shrink: 0;
}

.extra-work-subdir {
  width: 130px;
  flex-shrink: 0;
}

.remove-btn {
  padding: 4px 8px;
  background-color: #ffebee;
  color: #d32f2f;
  border: 1px solid #ffcdd2;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  flex-shrink: 0;
}

.remove-btn:hover:not(:disabled) {
  background-color: #ffcdd2;
}

.add-extra-btn {
  padding: 6px 12px;
  background-color: #e8f5e9;
  color: #2e7d32;
  border: 1px solid #c8e6c9;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  width: auto;
}

.add-extra-btn:hover:not(:disabled) {
  background-color: #c8e6c9;
}
</style>
