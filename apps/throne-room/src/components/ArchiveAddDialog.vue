<template>
  <div class="modal-overlay" @click.self="$emit('cancel')">
    <div class="modal">
      <h2>Add {{ typeLabel }} Archive</h2>

      <form @submit.prevent="handleSubmit">

        <div class="form-group">
          <label>Name:</label>
          <input
            v-model="name"
            type="text"
            required
            :placeholder="props.type === 'private' ? 'local or global' : 'archive-name'"
            pattern="[a-zA-Z0-9_-]+"
            title="Only letters, numbers, hyphens, and underscores allowed"
          />
          <p v-if="props.type === 'private'" class="hint">
            Private archives can only be named "local" or "global"
          </p>
        </div>

        <div v-if="props.type !== 'private'" class="form-group">
          <label>Repository URL:</label>
          <input
            v-model="url"
            type="text"
            required
            placeholder="https://github.com/user/repo.git"
          />
        </div>

        <div v-if="error" class="error">
          {{ error }}
        </div>

        <div v-if="success" class="success">
          {{ success }}
        </div>

        <div class="actions">
          <button type="button" @click="$emit('cancel')" :disabled="loading">
            Cancel
          </button>
          <button type="submit" :disabled="loading">
            {{ loading ? 'Adding...' : 'Add Archive' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { callMCPLair } from '../api/cabinet';
import type { ArchivesAddResult } from '@minions/mcp-types';

const props = defineProps<{
  type: 'work' | 'info' | 'private';
}>();

const emit = defineEmits<{
  cancel: [];
  added: [archiveName: string];
}>();

const name = ref('');
const url = ref('');
const loading = ref(false);
const error = ref<string | null>(null);
const success = ref<string | null>(null);

const typeLabel = computed(() => {
  return props.type.charAt(0).toUpperCase() + props.type.slice(1);
});

async function handleSubmit() {
  error.value = null;
  success.value = null;

  // Validate private archive name
  if (props.type === 'private' && name.value !== 'local' && name.value !== 'global') {
    error.value = 'Private archives can only be named "local" or "global"';
    return;
  }

  // Validate URL for work/info
  if ((props.type === 'work' || props.type === 'info') && !url.value) {
    error.value = 'URL is required for work and info archives';
    return;
  }

  try {
    loading.value = true;

    const result = await callMCPLair('archives', {
      action: 'add',
      type: props.type,
      name: name.value,
      url: url.value || undefined
    });

    success.value = (result as ArchivesAddResult).message;

    // Emit success and close after a brief delay
    setTimeout(() => {
      emit('added', name.value);
    }, 1000);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to add archive';
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
