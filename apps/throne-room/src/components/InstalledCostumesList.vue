<template>
  <div class="installed-costumes">
    <StateDisplay
      :loading="loading"
      :error="error"
      :empty="costumes.length === 0"
      loading-text="Scanning closet..."
    >
      <template #error="{ error: errorMsg }">
        <p>Error loading costumes:</p>
        <p>{{ errorMsg }}</p>
      </template>
      <template #empty>
        <p>No costumes installed. Use "Install Costume" to add a built costume from a wing.</p>
      </template>

      <div class="costumes-grid">
        <div
          v-for="costume in costumes"
          :key="costume.name"
          class="costume-card"
          :class="{ expanded: expandedCostume === costume.name }"
        >
          <div class="costume-header" @click="toggleExpanded(costume.name)">
            <div class="costume-info">
              <h4>{{ costume.name }}</h4>
              <span v-if="costume.isDebugInstalled" class="debug-badge">Debug</span>
            </div>
            <span class="expand-icon">{{ expandedCostume === costume.name ? '▼' : '▶' }}</span>
          </div>

          <div v-if="expandedCostume === costume.name" class="costume-details">
            <!-- Debug source info -->
            <div v-if="costume.isDebugInstalled && costume.debugSourceWing" class="source-info">
              <span class="label">Source:</span>
              <span class="value">{{ costume.debugSourceWing }}:{{ costume.debugSourcePath }}</span>
            </div>

            <!-- Contents -->
            <div class="contents-section">
              <!-- Missions -->
              <div v-if="costume.missions.length > 0" class="content-group">
                <span class="content-label">Missions:</span>
                <ul class="content-list">
                  <li v-for="mission in costume.missions" :key="mission">{{ mission }}</li>
                </ul>
              </div>

              <!-- Disguises -->
              <div v-if="costume.disguises.length > 0" class="content-group">
                <span class="content-label">Disguises:</span>
                <ul class="content-list">
                  <li v-for="disguise in costume.disguises" :key="disguise">{{ disguise }}</li>
                </ul>
              </div>

              <!-- Skills -->
              <div v-if="costume.skills.length > 0" class="content-group">
                <span class="content-label">Skills:</span>
                <ul class="content-list">
                  <li v-for="skill in costume.skills" :key="skill">{{ skill }}</li>
                </ul>
              </div>

              <!-- No contents -->
              <p v-if="costume.missions.length === 0 && costume.disguises.length === 0 && costume.skills.length === 0" class="no-contents">
                No missions, disguises, or skills
              </p>
            </div>

            <!-- Publish action -->
            <div class="detail-actions">
              <button class="publish-btn" @click="openPublish(costume)">Publish</button>
            </div>
          </div>
        </div>
      </div>
    </StateDisplay>

    <!-- Publish Dialog -->
    <PublishCostumeDialog
      v-if="publishingCostume"
      :costume="publishingCostume"
      @cancel="publishingCostume = null"
      @published="publishingCostume = null"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { callMCPLairRaw } from '../api/cabinet';
import type { InstalledCostumeSummary } from '@minions/mcp-types';
import StateDisplay from './StateDisplay.vue';
import PublishCostumeDialog from './PublishCostumeDialog.vue';

const costumes = ref<InstalledCostumeSummary[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const expandedCostume = ref<string | null>(null);
const publishingCostume = ref<InstalledCostumeSummary | null>(null);

async function loadCostumes() {
  try {
    loading.value = true;
    error.value = null;
    const result = await callMCPLairRaw<{ costumes: InstalledCostumeSummary[] }>('costumes', { action: 'list' });
    costumes.value = result.costumes;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Unknown error';
  } finally {
    loading.value = false;
  }
}

function toggleExpanded(name: string) {
  expandedCostume.value = expandedCostume.value === name ? null : name;
}

function openPublish(costume: InstalledCostumeSummary) {
  publishingCostume.value = costume;
}

// Expose reload method for parent components
defineExpose({ loadCostumes });

onMounted(() => {
  loadCostumes();
});
</script>

<style scoped>
.installed-costumes {
  margin-top: 16px;
}

.costumes-grid {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.costume-card {
  border: 1px solid #ddd;
  border-radius: 6px;
  background: #fff;
  overflow: hidden;
}

.costume-card.expanded {
  border-color: #1976d2;
}

.costume-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  cursor: pointer;
  background: #f9f9f9;
  transition: background 0.2s;
}

.costume-header:hover {
  background: #f0f0f0;
}

.costume-info {
  display: flex;
  align-items: center;
  gap: 10px;
}

.costume-info h4 {
  margin: 0;
  color: #333;
  font-size: 15px;
}

.debug-badge {
  display: inline-block;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  color: #1976d2;
  background: #e3f2fd;
  border-radius: 4px;
}

.expand-icon {
  color: #666;
  font-size: 12px;
}

.costume-details {
  padding: 16px;
  border-top: 1px solid #eee;
  background: #fff;
}

.source-info {
  margin-bottom: 16px;
  padding: 10px 12px;
  background: #f5f5f5;
  border-radius: 4px;
  font-size: 13px;
}

.source-info .label {
  color: #666;
  margin-right: 8px;
}

.source-info .value {
  font-family: monospace;
  color: #333;
}

.contents-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.content-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.content-label {
  font-size: 12px;
  font-weight: 600;
  color: #666;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.content-list {
  margin: 0;
  padding-left: 20px;
  font-size: 14px;
  color: #333;
}

.content-list li {
  padding: 2px 0;
}

.no-contents {
  font-size: 13px;
  color: #999;
  font-style: italic;
  margin: 0;
}

.detail-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid #eee;
}

.publish-btn {
  padding: 6px 14px;
  background: #1976d2;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
}

.publish-btn:hover {
  background: #1565c0;
}
</style>
