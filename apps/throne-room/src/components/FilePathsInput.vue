<!--
/**
 * FilePathsInput — multiple file-paths selector
 *
 * modelValue is always string[] (zero or more repo-relative paths).
 * Drag-and-drop matches dropped file by name and toggles it in the list.
 * "Browse…" opens a searchable modal picker with checkboxes and a Done button.
 */
-->
<template>
  <div class="file-paths-input" :class="{ 'is-dragging': isDragging }">
    <div
      class="display-area"
      @dragenter.prevent="isDragging = true"
      @dragleave.prevent="isDragging = false"
      @dragover.prevent
      @drop.prevent="handleDrop"
    >
      <span v-if="!modelValue.length" class="placeholder">
        {{ isDragging ? 'Drop files here' : 'No files selected' }}
      </span>
      <span v-for="p in modelValue" :key="p" class="chip">
        <span class="chip-text" :title="p">{{ basename(p) }}</span>
        <button type="button" class="chip-remove" @click.stop="remove(p)">×</button>
      </span>
      <button type="button" class="browse-button" @click="openPicker()">Browse…</button>
    </div>

    <div v-if="dragError" class="error-text">{{ dragError }}</div>

    <Teleport to="body">
      <div v-if="isOpen" class="picker-backdrop" @mousedown.self="closePicker">
        <div class="picker-panel" role="dialog" aria-label="Select files">
          <div class="picker-header">
            <input
              ref="searchInputRef"
              v-model="search"
              class="picker-search"
              placeholder="Search files…"
              @keydown="e => handleKeydown(e, toggle)"
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
              :class="{ 'is-active': i === activeIndex, 'is-selected': modelValue.includes(file) }"
              role="option"
              :aria-selected="modelValue.includes(file)"
              @mouseenter="activeIndex = i"
              @click="toggle(file)"
            >
              <span class="item-name">{{ basename(file) }}</span>
              <span class="item-dir">{{ dirname(file) }}</span>
              <span v-if="modelValue.includes(file)" class="item-check">✓</span>
            </li>
          </ul>
          <div class="picker-footer">
            <span>{{ modelValue.length }} selected</span>
            <button type="button" class="done-button" @click="closePicker">Done</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useFilePicker, basename, dirname } from '../composables/useFilePicker';

const props = defineProps<{
  modelValue: string[];
  wingName: string;
  required?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string[]];
}>();

const isDragging = ref(false);
const dragError = ref<string | null>(null);

const {
  isOpen, search, filteredFiles, loading, loadError,
  activeIndex, searchInputRef, listRef,
  openPicker, closePicker, handleKeydown, resolveDroppedFile,
} = useFilePicker(() => props.wingName);

function toggle(file: string) {
  if (props.modelValue.includes(file)) {
    emit('update:modelValue', props.modelValue.filter(f => f !== file));
  } else {
    emit('update:modelValue', [...props.modelValue, file]);
  }
}

function remove(file: string) {
  emit('update:modelValue', props.modelValue.filter(f => f !== file));
}

function handleDrop(event: DragEvent) {
  isDragging.value = false;
  dragError.value = null;
  const file = event.dataTransfer?.files[0];
  if (!file) return;
  void resolveDroppedFile(
    file.name,
    (path) => toggle(path),
    (preSearch) => void openPicker(preSearch),
    (name) => { dragError.value = `"${name}" not found in repository. Use Browse to search.`; },
  );
}
</script>

<style scoped>
.file-paths-input {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.display-area {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
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

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px 2px 8px;
  background: #ede7f6;
  border-radius: 12px;
  font-size: 12px;
  max-width: 200px;
}

.chip-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip-remove {
  background: none;
  border: none;
  cursor: pointer;
  color: #7b1fa2;
  font-size: 14px;
  line-height: 1;
  padding: 0;
  flex-shrink: 0;
}

.chip-remove:hover {
  color: #4a148c;
}

.browse-button {
  margin-left: auto;
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
