<!--
/**
 * FilePathInput — single file-path selector
 *
 * modelValue is always a string (one repo-relative path).
 * Drag-and-drop matches dropped file by name against the repo file list.
 * "Browse…" opens a searchable modal picker backed by /api/files/list.
 */
-->
<template>
  <div class="file-path-input" :class="{ 'is-dragging': isDragging }">
    <div
      class="display-area"
      @dragenter.prevent="isDragging = true"
      @dragleave.prevent="isDragging = false"
      @dragover.prevent
      @drop.prevent="handleDrop"
    >
      <span v-if="modelValue" class="single-path" :title="modelValue">{{ modelValue }}</span>
      <span v-else class="placeholder">{{ isDragging ? 'Drop file here' : 'No file selected' }}</span>
      <button v-if="modelValue" type="button" class="clear-button" @click.stop="$emit('update:modelValue', '')">×</button>
      <button type="button" class="browse-button" @click="openPicker()">Browse…</button>
    </div>

    <div v-if="dragError" class="error-text">{{ dragError }}</div>

    <Teleport to="body">
      <div v-if="isOpen" class="picker-backdrop" @mousedown.self="closePicker">
        <div class="picker-panel" role="dialog" aria-label="Select file">
          <div class="picker-header">
            <input
              ref="searchInputRef"
              v-model="search"
              class="picker-search"
              placeholder="Search files…"
              @keydown="e => handleKeydown(e, pick)"
            />
            <button type="button" class="picker-close" @click="closePicker">✕</button>
          </div>
          <div v-if="loading" class="picker-status">Loading…</div>
          <div v-else-if="loadError" class="picker-status picker-status--error">{{ loadError }}</div>
          <div v-else-if="!filteredFiles.length" class="picker-status picker-status--muted">No files match</div>
          <ul v-else ref="listRef" class="picker-list" role="listbox">
            <li
              v-for="(file, i) in filteredFiles"
              :key="file"
              class="picker-item"
              :class="{ 'is-active': i === activeIndex, 'is-selected': file === modelValue }"
              role="option"
              :aria-selected="file === modelValue"
              @mouseenter="activeIndex = i"
              @click="pick(file)"
            >
              <span class="item-name">{{ basename(file) }}</span>
              <span class="item-dir">{{ dirname(file) }}</span>
              <span v-if="file === modelValue" class="item-check">✓</span>
            </li>
          </ul>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useFilePicker, basename, dirname } from '../composables/useFilePicker';

const props = defineProps<{
  modelValue: string;
  wingName: string;
  required?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const isDragging = ref(false);
const dragError = ref<string | null>(null);

const {
  isOpen, search, filteredFiles, loading, loadError,
  activeIndex, searchInputRef, listRef,
  openPicker, closePicker, handleKeydown, resolveDroppedFile,
} = useFilePicker(() => props.wingName);

function pick(file: string) {
  emit('update:modelValue', file);
  closePicker();
}

function handleDrop(event: DragEvent) {
  isDragging.value = false;
  dragError.value = null;
  const file = event.dataTransfer?.files[0];
  if (!file) return;
  void resolveDroppedFile(
    file.name,
    (path) => pick(path),
    (preSearch) => void openPicker(preSearch),
    (name) => { dragError.value = `"${name}" not found in repository. Use Browse to search.`; },
  );
}
</script>

<style scoped>
.file-path-input {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.display-area {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 6px 10px;
  border: 1px solid #ccc;
  border-radius: 4px;
  background: white;
  transition: border-color 0.15s, background 0.15s;
}

.is-dragging .display-area {
  border-color: #7b1fa2;
  background: #f3e5f5;
}

.placeholder {
  color: #aaa;
  font-size: 13px;
  flex: 1;
}

.single-path {
  flex: 1;
  font-family: monospace;
  font-size: 13px;
  color: #333;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.clear-button {
  background: none;
  border: none;
  cursor: pointer;
  color: #999;
  font-size: 16px;
  line-height: 1;
  padding: 0 2px;
  flex-shrink: 0;
}

.clear-button:hover {
  color: #555;
}

.browse-button {
  flex-shrink: 0;
  padding: 4px 10px;
  background: #7b1fa2;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.browse-button:hover {
  background: #6a1b9a;
}

.error-text {
  font-size: 12px;
  color: #c00;
}
</style>

<style src="./file-picker.css" />
