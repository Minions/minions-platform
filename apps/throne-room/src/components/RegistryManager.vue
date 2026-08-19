<template>
  <div class="registry-manager">
    <div class="section-header">
      <h3>Registries</h3>
      <button class="add-btn" @click="showAddForm = !showAddForm" :disabled="saving">
        {{ showAddForm ? 'Cancel' : '+ Add Registry' }}
      </button>
    </div>

    <!-- Inline add form -->
    <div v-if="showAddForm" class="add-form">
      <form @submit.prevent="handleAdd">
        <div class="form-group">
          <label>Name:</label>
          <input
            v-model="newName"
            type="text"
            required
            placeholder="my-registry"
            pattern="[a-zA-Z0-9_-]+"
            title="Only letters, numbers, hyphens, and underscores"
          />
        </div>
        <div class="form-group">
          <label>Index URL:</label>
          <input
            v-model="newIndexBaseUrl"
            type="url"
            required
            placeholder="https://registry.example.com"
          />
        </div>
        <div class="form-group">
          <label>Auth Env Var <span class="optional">(optional)</span>:</label>
          <input
            v-model="newAuthEnvVar"
            type="text"
            placeholder="REGISTRY_TOKEN"
          />
          <p class="hint">Environment variable holding the auth token</p>
        </div>
        <div v-if="addError" class="error">{{ addError }}</div>
        <div class="form-actions">
          <button type="button" @click="cancelAdd" :disabled="saving">Cancel</button>
          <button type="submit" :disabled="saving">
            {{ saving ? 'Adding...' : 'Add Registry' }}
          </button>
        </div>
      </form>
    </div>

    <!-- Registry list -->
    <StateDisplay
      :loading="loading"
      :error="loadError"
      :empty="registries.length === 0"
      loading-text="Loading registries..."
    >
      <template #error="{ error: errorMsg }">
        <p>Error loading registries:</p>
        <p>{{ errorMsg }}</p>
      </template>
      <template #empty>
        <p>No registries configured. Add one to enable costume publishing.</p>
      </template>

      <div class="registries-list">
        <div
          v-for="reg in registries"
          :key="reg.name"
          class="registry-card"
        >
          <div class="registry-info">
            <div class="registry-name">{{ reg.name }}</div>
            <div class="registry-url">{{ reg.indexBaseUrl }}</div>
            <div class="registry-badges">
              <span v-if="reg.auth" class="badge badge-auth" :title="'Auth via ' + reg.auth.envVar">
                Auth: {{ reg.auth.envVar }}
              </span>
              <span v-if="reg.hasPublishApi" class="badge badge-api">API</span>
              <span v-if="reg.hasPublishDirect" class="badge badge-direct">Direct</span>
            </div>
          </div>
          <div class="registry-actions">
            <template v-if="removingName === reg.name">
              <span class="confirm-text">Remove?</span>
              <button class="confirm-yes-btn" @click="confirmRemove(reg.name)" :disabled="saving">Yes</button>
              <button class="confirm-no-btn" @click="removingName = null" :disabled="saving">No</button>
            </template>
            <button
              v-else
              class="remove-btn"
              @click="removingName = reg.name"
              :disabled="saving"
            >
              Remove
            </button>
          </div>
        </div>
      </div>
    </StateDisplay>

    <div v-if="removeError" class="error" style="margin-top: 10px;">{{ removeError }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { callMCPLairRaw } from '../api/cabinet';
import StateDisplay from './StateDisplay.vue';

interface Registry {
  name: string;
  indexBaseUrl: string;
  hasPublishApi: boolean;
  hasPublishDirect: boolean;
  auth?: { type: string; envVar: string };
}

const registries = ref<Registry[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);
const saving = ref(false);

const showAddForm = ref(false);
const newName = ref('');
const newIndexBaseUrl = ref('');
const newAuthEnvVar = ref('');
const addError = ref<string | null>(null);

const removingName = ref<string | null>(null);
const removeError = ref<string | null>(null);

async function loadRegistries() {
  try {
    loading.value = true;
    loadError.value = null;
    const data = await callMCPLairRaw<{ registries: Registry[] }>('registry', { action: 'list' });
    registries.value = data.registries;
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Unknown error';
  } finally {
    loading.value = false;
  }
}

onMounted(loadRegistries);

function cancelAdd() {
  showAddForm.value = false;
  newName.value = '';
  newIndexBaseUrl.value = '';
  newAuthEnvVar.value = '';
  addError.value = null;
}

async function handleAdd() {
  addError.value = null;
  try {
    saving.value = true;
    const args: Record<string, unknown> = {
      action: 'add',
      name: newName.value,
      indexBaseUrl: newIndexBaseUrl.value,
    };
    if (newAuthEnvVar.value) args.authEnvVar = newAuthEnvVar.value;

    await callMCPLairRaw('registry', args);
    cancelAdd();
    await loadRegistries();
  } catch (e) {
    addError.value = e instanceof Error ? e.message : 'Failed to add registry';
  } finally {
    saving.value = false;
  }
}

async function confirmRemove(name: string) {
  removeError.value = null;
  try {
    saving.value = true;
    await callMCPLairRaw('registry', { action: 'remove', name });
    removingName.value = null;
    await loadRegistries();
  } catch (e) {
    removeError.value = e instanceof Error ? e.message : 'Failed to remove registry';
    removingName.value = null;
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.registry-manager {
  margin-top: 24px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.section-header h3 {
  margin: 0;
  color: #333;
  font-size: 16px;
}

.add-btn {
  padding: 8px 16px;
  background: #1976d2;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
}

.add-btn:hover:not(:disabled) {
  background: #1565c0;
}

.add-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.add-form {
  background: #f9f9f9;
  border: 1px solid #ddd;
  border-radius: 6px;
  padding: 16px;
  margin-bottom: 16px;
}

.form-group {
  margin-bottom: 14px;
}

.form-group label {
  display: block;
  margin-bottom: 6px;
  font-weight: 500;
  color: #555;
  font-size: 14px;
}

.form-group input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 14px;
  font-family: inherit;
  box-sizing: border-box;
}

.form-group input:focus {
  outline: none;
  border-color: #0066cc;
}

.optional {
  font-weight: 400;
  color: #999;
  font-size: 12px;
}

.hint {
  margin: 4px 0 0 0;
  font-size: 12px;
  color: #666;
  font-style: italic;
}

.form-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 4px;
}

.form-actions button {
  padding: 8px 16px;
  border: 1px solid #ddd;
  border-radius: 4px;
  background: white;
  cursor: pointer;
  font-size: 14px;
}

.form-actions button:hover:not(:disabled) {
  background: #f5f5f5;
}

.form-actions button[type="submit"] {
  background: #0066cc;
  color: white;
  border-color: #0066cc;
}

.form-actions button[type="submit"]:hover:not(:disabled) {
  background: #0052a3;
}

.form-actions button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.registries-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.registry-card {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 12px 16px;
  border: 1px solid #ddd;
  border-radius: 6px;
  background: #fff;
  gap: 12px;
}

.registry-info {
  flex: 1;
  min-width: 0;
}

.registry-name {
  font-weight: 600;
  color: #333;
  font-size: 14px;
}

.registry-url {
  font-size: 12px;
  color: #666;
  font-family: monospace;
  margin-top: 2px;
  word-break: break-all;
}

.registry-badges {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  flex-wrap: wrap;
}

.badge {
  display: inline-block;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  border-radius: 4px;
}

.badge-auth {
  color: #7b1fa2;
  background: #f3e5f5;
}

.badge-api {
  color: #1976d2;
  background: #e3f2fd;
}

.badge-direct {
  color: #2e7d32;
  background: #e8f5e9;
}

.registry-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.confirm-text {
  font-size: 13px;
  color: #c33;
}

.remove-btn {
  padding: 5px 12px;
  background: white;
  color: #c33;
  border: 1px solid #fcc;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

.remove-btn:hover:not(:disabled) {
  background: #fee;
}

.remove-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.confirm-yes-btn {
  padding: 5px 10px;
  background: #c33;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

.confirm-yes-btn:hover:not(:disabled) {
  background: #a00;
}

.confirm-yes-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.confirm-no-btn {
  padding: 5px 10px;
  background: white;
  color: #555;
  border: 1px solid #ddd;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

.confirm-no-btn:hover:not(:disabled) {
  background: #f5f5f5;
}

.confirm-no-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.error {
  padding: 10px;
  background: #fee;
  border: 1px solid #fcc;
  border-radius: 4px;
  color: #c33;
  font-size: 13px;
}
</style>
