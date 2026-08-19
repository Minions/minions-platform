<template>
  <div class="modal-overlay" @click.self="$emit('cancel')">
    <div class="modal">
      <h2>Publish Costume</h2>
      <p class="costume-name">{{ costume.name }}</p>

      <form @submit.prevent="handleSubmit">
        <!-- Version -->
        <div class="form-group">
          <label>Version:</label>
          <input
            v-model="version"
            type="text"
            required
            :placeholder="isPreview ? '1.0.0-pre' : '1.0.0'"
            :class="{ 'input-error': versionError }"
          />
          <p v-if="versionError" class="field-error">{{ versionError }}</p>
          <p v-else class="hint">Semver version (e.g. {{ isPreview ? '1.2.3-pre' : '1.2.3' }})</p>
        </div>

        <!-- Preview toggle -->
        <div class="form-group checkbox-group">
          <label class="checkbox-label">
            <input type="checkbox" v-model="isPreview" />
            Preview version
          </label>
          <p class="hint">Preview versions can be replaced with a new package after publishing.</p>
        </div>

        <!-- Registry -->
        <div class="form-group">
          <label>Registry:</label>
          <select v-model="registryName" required :disabled="loadingRegistries">
            <option v-if="loadingRegistries" value="">Loading registries...</option>
            <option v-else-if="registries.length === 0" value="">No registries configured</option>
            <option
              v-for="reg in registries"
              :key="reg.name"
              :value="reg.name"
            >
              {{ reg.name }} — {{ reg.indexBaseUrl }}
            </option>
          </select>
        </div>

        <!-- Optional: publish from wing -->
        <details class="optional-section">
          <summary>Publish from wing (optional)</summary>
          <div class="form-group">
            <label>Wing:</label>
            <input
              v-model="wing"
              type="text"
              placeholder="workshop-01"
            />
          </div>
          <div class="form-group">
            <label>Costume Path:</label>
            <input
              v-model="costumePath"
              type="text"
              placeholder="costumes/my-costume"
            />
          </div>
        </details>

        <div v-if="error" class="error">{{ error }}</div>

        <div v-if="result" class="result">
          <p class="success">{{ result.message }}</p>
          <p><strong>URL:</strong> <a :href="result.url" target="_blank" rel="noopener noreferrer">{{ result.url }}</a></p>
          <p><strong>Digest:</strong> <code>{{ result.digest }}</code></p>
        </div>

        <div class="actions">
          <button type="button" @click="$emit('cancel')" :disabled="loading">
            {{ result ? 'Close' : 'Cancel' }}
          </button>
          <button type="submit" :disabled="loading || !!result || loadingRegistries">
            {{ loading ? 'Publishing...' : 'Publish' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { callMCPLairRaw } from '../api/cabinet';
import type { InstalledCostumeSummary } from '@minions/mcp-types';

interface Registry {
  name: string;
  indexBaseUrl: string;
  hasPublishApi: boolean;
  hasPublishDirect: boolean;
  auth?: { type: string; envVar: string };
}

interface PublishResult {
  action: string;
  message: string;
  url: string;
  digest: string;
}

const props = defineProps<{
  costume: InstalledCostumeSummary;
}>();

const emit = defineEmits<{
  cancel: [];
  published: [result: PublishResult];
}>();

const version = ref('');
const registryName = ref('');
const wing = ref('');
const costumePath = ref('');
const isPreview = ref(false);
const loading = ref(false);
const loadingRegistries = ref(true);
const error = ref<string | null>(null);
const result = ref<PublishResult | null>(null);
const registries = ref<Registry[]>([]);

const SEMVER_PATTERN = /^\d+\.\d+\.\d+/;

const versionError = computed(() => {
  if (!version.value) return null;
  return SEMVER_PATTERN.test(version.value) ? null : 'Must match semver format (e.g. 1.2.3 or 1.2.3-pre)';
});

async function loadRegistries() {
  try {
    loadingRegistries.value = true;
    const data = await callMCPLairRaw<{ registries: Registry[] }>('registry', { action: 'list' });
    registries.value = data.registries;
    if (data.registries.length > 0) {
      registryName.value = data.registries[0].name;
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load registries';
  } finally {
    loadingRegistries.value = false;
  }
}

onMounted(loadRegistries);

async function handleSubmit() {
  error.value = null;

  if (!version.value) {
    error.value = 'Version is required';
    return;
  }
  if (versionError.value) {
    error.value = versionError.value;
    return;
  }
  if (!registryName.value) {
    error.value = 'Please select a registry';
    return;
  }

  try {
    loading.value = true;
    const args: Record<string, unknown> = {
      action: 'publish',
      name: props.costume.name,
      version: version.value,
      registry: registryName.value,
    };
    if (isPreview.value) args.preview = true;
    if (wing.value) args.wing = wing.value;
    if (costumePath.value) args.costumePath = costumePath.value;

    const publishResult = await callMCPLairRaw<PublishResult>('costumes', args);
    result.value = publishResult;
    emit('published', publishResult);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to publish costume';
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
  margin: 0 0 4px 0;
  color: #333;
}

.costume-name {
  margin: 0 0 20px 0;
  font-size: 13px;
  color: #888;
  font-family: monospace;
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
  box-sizing: border-box;
}

.form-group input:focus,
.form-group select:focus {
  outline: none;
  border-color: #0066cc;
}

.input-error {
  border-color: #c33 !important;
}

.field-error {
  margin: 4px 0 0 0;
  font-size: 12px;
  color: #c33;
}

.hint {
  margin: 6px 0 0 0;
  font-size: 12px;
  color: #666;
  font-style: italic;
}

.checkbox-group {
  margin-bottom: 16px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
  color: #555;
  cursor: pointer;
}

.checkbox-label input[type="checkbox"] {
  width: auto;
  padding: 0;
  border: none;
  cursor: pointer;
}

.optional-section {
  margin-bottom: 16px;
  padding: 12px;
  background: #f9f9f9;
  border: 1px solid #eee;
  border-radius: 4px;
}

.optional-section summary {
  cursor: pointer;
  font-size: 13px;
  color: #555;
  font-weight: 500;
  user-select: none;
  margin-bottom: 0;
}

.optional-section[open] summary {
  margin-bottom: 12px;
}

.optional-section .form-group:last-child {
  margin-bottom: 0;
}

.error {
  padding: 10px;
  background: #fee;
  border: 1px solid #fcc;
  border-radius: 4px;
  color: #c33;
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

.result a {
  color: #0066cc;
}

.result code {
  font-size: 12px;
}

.success {
  padding: 10px;
  background: #efe;
  border: 1px solid #cfc;
  border-radius: 4px;
  color: #3a3;
  margin-bottom: 8px;
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
