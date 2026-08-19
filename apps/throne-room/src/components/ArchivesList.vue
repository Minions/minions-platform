<template>
  <div class="archives-list">
    <StateDisplay
      :loading="loading"
      :error="error"
      loading-text="Scanning archives..."
    >
      <template #error="{ error: errorMsg }">
        <p>Error loading archives:</p>
        <p>{{ errorMsg }}</p>
      </template>

      <div class="archives-container">
      <!-- Work Archives -->
      <div class="archive-section">
        <div class="section-header">
          <h4>Work</h4>
          <button @click="openAddDialog('work')" class="add-button-small">+ Add</button>
        </div>
        <ul v-if="workArchives.length > 0" class="archive-list">
          <li v-for="archive in workArchives" :key="archive.name" class="archive-item">
            <div class="archive-content">
              <strong>{{ archive.name }}</strong>
              <span v-if="archive.remoteUrl" class="remote">
                → <a :href="archive.remoteUrl" target="_blank" rel="noopener noreferrer">{{ archive.remoteUrl }}</a>
              </span>
              <span v-else class="no-remote">→ no remote</span>
            </div>
            <button @click="handleRemove('work', archive.name)" class="remove-button" title="Remove archive">×</button>
          </li>
        </ul>
        <p v-else class="empty-section">No work archives</p>
      </div>

      <!-- Info Archives -->
      <div class="archive-section">
        <div class="section-header">
          <h4>Info <span class="quieter">(read-only)</span></h4>
          <button @click="openAddDialog('info')" class="add-button-small">+ Add</button>
        </div>
        <ul v-if="infoArchives.length > 0" class="archive-list">
          <li v-for="archive in infoArchives" :key="archive.name" class="archive-item">
            <div class="archive-content">
              <strong>{{ archive.name }}</strong>
              <span v-if="archive.remoteUrl" class="remote">
                → <a :href="archive.remoteUrl" target="_blank" rel="noopener noreferrer">{{ archive.remoteUrl }}</a>
              </span>
              <span v-else class="no-remote">→ no remote</span>
            </div>
            <button @click="handleRemove('info', archive.name)" class="remove-button" title="Remove archive">×</button>
          </li>
        </ul>
        <p v-else class="empty-section">No info archives</p>
      </div>

      <!-- Private Archives -->
      <div class="archive-section">
        <div class="section-header">
          <h4>Private <span class="quieter">(internal)</span></h4>
          <button @click="openAddDialog('private')" class="add-button-small">+ Add</button>
        </div>
        <ul v-if="privateArchives.length > 0" class="archive-list">
          <li v-for="archive in privateArchives" :key="archive.name" class="archive-item">
            <div class="archive-content">
              <strong>{{ archive.name }}</strong>
              <span v-if="archive.remoteUrl" class="remote">
                → <a :href="archive.remoteUrl" target="_blank" rel="noopener noreferrer">{{ archive.remoteUrl }}</a>
              </span>
              <span v-else class="no-remote">→ no remote</span>
            </div>
            <button @click="handleRemove('private', archive.name)" class="remove-button" title="Remove archive">×</button>
          </li>
        </ul>
        <p v-else class="empty-section">No private archives</p>
      </div>
      </div>
    </StateDisplay>

    <!-- Add Archive Dialog -->
    <ArchiveAddDialog
      v-if="showAddDialog"
      :type="addDialogType"
      @added="handleArchiveAdded"
      @cancel="showAddDialog = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { callMCPLair } from '../api/cabinet';
import type { ArchiveSummary, ArchivesListResult } from '@minions/mcp-types';
import ArchiveAddDialog from './ArchiveAddDialog.vue';
import StateDisplay from './StateDisplay.vue';

const archives = ref<ArchiveSummary[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const showAddDialog = ref(false);
const addDialogType = ref<'work' | 'info' | 'private'>('work');

const workArchives = computed(() => archives.value.filter(a => a.type === 'work'));
const infoArchives = computed(() => archives.value.filter(a => a.type === 'info'));
const privateArchives = computed(() => archives.value.filter(a => a.type === 'private'));

async function loadArchives() {
  try {
    loading.value = true;
    error.value = null;
    const result = await callMCPLair('archives', { action: 'list' });
    archives.value = (result as ArchivesListResult).archives;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Unknown error';
  } finally {
    loading.value = false;
  }
}

function openAddDialog(type: 'work' | 'info' | 'private') {
  addDialogType.value = type;
  showAddDialog.value = true;
}

async function handleArchiveAdded() {
  showAddDialog.value = false;
  await loadArchives(); // Refresh the list
}

async function handleRemove(type: 'work' | 'info' | 'private', name: string) {
  if (!confirm(`Are you sure you want to remove the archive "${name}" from ${type}/?`)) {
    return;
  }

  try {
    loading.value = true;
    error.value = null;
    await callMCPLair('archives', { action: 'remove', type, name });
    await loadArchives(); // Refresh the list
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to remove archive';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  loadArchives();
});
</script>

<style scoped>
.archives-list {
  padding: 20px;
}

.quieter {
  font-size: 90%;
  color: #666;
}

h3 {
  margin: 0;
  color: #333;
}

.archives-container {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.archive-section {
  border: 1px solid #ddd;
  border-radius: 6px;
  padding: 12px 16px;
  background: #f9f9f9;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.archive-section h4 {
  margin: 0;
  color: #333;
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.add-button-small {
  padding: 4px 10px;
  background: #0066cc;
  color: white;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
}

.add-button-small:hover {
  background: #0052a3;
}

.empty-section {
  margin: 0;
  padding: 8px 0;
  color: #999;
  font-size: 13px;
  font-style: italic;
}

.archive-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.archive-list li.archive-item {
  padding: 4px 0;
  font-size: 14px;
  line-height: 1.6;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.archive-content {
  flex: 1;
}

.archive-list li strong {
  color: #222;
  margin-right: 8px;
}

.archive-list li .remote {
  color: #666;
}

.remove-button {
  padding: 2px 8px;
  background: #dc3545;
  color: white;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  font-size: 16px;
  font-weight: bold;
  line-height: 1;
  flex-shrink: 0;
}

.remove-button:hover {
  background: #c82333;
}

.archive-list li a {
  color: #0066cc;
  text-decoration: none;
  word-break: break-all;
}

.archive-list li a:hover {
  text-decoration: underline;
}

.no-remote {
  color: #999;
  font-style: italic;
}
</style>
