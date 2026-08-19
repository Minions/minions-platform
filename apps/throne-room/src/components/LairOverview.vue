<template>
  <div class="lair-overview">
    <div class="header">
      <h2>
        {{ currentView === 'switchyard' ? 'Switchyard' :
           currentView === 'wings' ? 'Lair Wings' :
           currentView === 'archives' ? 'Lair Archives' :
           currentView === 'costumes' ? 'Costumes' :
           currentView === 'quality' ? 'Quality' : 'Cabinet API' }}
      </h2>
      <div class="actions">
        <div class="view-tabs">
          <button
            @click="currentView = 'switchyard'"
            :class="{ active: currentView === 'switchyard' }"
            class="tab-button"
          >
            Switchyard
          </button>
          <button
            @click="currentView = 'wings'"
            :class="{ active: currentView === 'wings' }"
            class="tab-button"
          >
            Wings
          </button>
          <button
            @click="currentView = 'archives'"
            :class="{ active: currentView === 'archives' }"
            class="tab-button"
          >
            Archives
          </button>
          <button
            @click="currentView = 'costumes'"
            :class="{ active: currentView === 'costumes' }"
            class="tab-button"
          >
            Costumes
          </button>
          <button
            @click="currentView = 'quality'"
            :class="{ active: currentView === 'quality' }"
            class="tab-button"
          >
            Quality
          </button>
          <button
            @click="currentView = 'api'"
            :class="{ active: currentView === 'api' }"
            class="tab-button"
          >
            API
          </button>
        </div>
        <button
          v-if="currentView === 'wings' && !showCreateForm"
          @click="showCreateForm = true"
        >
          + Build Wing
        </button>
      </div>
    </div>

    <!-- Wings View -->
    <div v-if="currentView === 'wings'">
      <WingCreateForm
        v-if="showCreateForm"
        @created="handleDistrictCreated"
        @cancel="showCreateForm = false"
      />

      <StateDisplay
        :loading="loading"
        :error="error"
        :empty="wings.length === 0"
        loading-text="Waking up the lair..."
      >
        <template #error="{ error: errorMsg }">
          <p>Error loading wings:</p>
          <p>{{ errorMsg }}</p>
        </template>
        <template #empty>
          <p>Your lair is empty. Time to build some wings for your minions to swarm.</p>
        </template>

        <div class="districts-list">
        <div
          v-for="wing in orderedDistricts"
          :key="wing.name"
          class="wing-card"
          :class="{ 'wing-selected': selectedWing === wing.name }"
        >
          <div
            class="wing-header"
            :class="{ clickable: selectedWing !== wing.name }"
            @click="selectedWing !== wing.name && toggleDistrict(wing.name)"
          >
            <div>
              <h3>{{ wing.name }}</h3>
              <p class="path">{{ wing.root }}</p>
            </div>
            <div class="wing-header-actions">
              <button
                @click.stop="showDeleteDialog(wing.name)"
                class="delete-wing-btn"
                title="Delete wing"
              >
                🗑️
              </button>
              <button
                v-if="selectedWing === wing.name"
                @click.stop="selectedWing = null"
                class="close-wing-btn"
                title="Close wing"
              >
                ✕
              </button>
            </div>
          </div>

          <WingManagement
            v-if="selectedWing === wing.name"
            :wing="wing"
          />
        </div>
        </div>
      </StateDisplay>

    </div>

    <!-- Archives View -->
    <ArchivesList v-if="currentView === 'archives'" />

    <!-- Costumes View -->
    <div v-if="currentView === 'costumes'" class="costumes-view">
      <div class="costumes-actions">
        <button @click="showCostumeInstall = true" class="install-btn">
          + Install Costume
        </button>
        <GitHubAuthWidget />
      </div>
      <p class="costumes-info">
        Costumes provide missions, disguises, and skills. Install a built costume from a wing's
        work/local directory to the lair's closet.
      </p>
      <InstalledCostumesList ref="installedCostumesList" />
      <RegistryManager />
    </div>

    <!-- Quality View -->
    <QualityPanel v-if="currentView === 'quality'" />

    <!-- API View -->
    <CabinetAPI v-if="currentView === 'api'" />

    <!-- Switchyard View -->
    <Switchyard v-if="currentView === 'switchyard'" />

    <!-- Wing Delete Dialog -->
    <WingDeleteDialog
      v-if="districtToDelete"
      :wing-name="districtToDelete"
      @deleted="handleDistrictDeleted"
      @cancel="districtToDelete = null"
    />

    <!-- Costume Install Dialog -->
    <CostumeInstallDialog
      v-if="showCostumeInstall"
      @cancel="showCostumeInstall = false"
      @installed="handleCostumeInstalled"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { callMCPThrone } from '../api/cabinet';
import WingManagement from './WingManagement.vue';
import WingCreateForm from './WingCreateForm.vue';
import WingDeleteDialog from './WingDeleteDialog.vue';
import CabinetAPI from './CabinetAPI.vue';
import ArchivesList from './ArchivesList.vue';
import StateDisplay from './StateDisplay.vue';
import CostumeInstallDialog from './CostumeInstallDialog.vue';
import InstalledCostumesList from './InstalledCostumesList.vue';
import GitHubAuthWidget from './GitHubAuthWidget.vue';
import RegistryManager from './RegistryManager.vue';
import Switchyard from './Switchyard.vue';
import QualityPanel from './QualityPanel.vue';
import type { Wing } from '../types/wing';

const route = useRoute();
const wings = ref<Wing[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const selectedWing = ref<string | null>(null);
const showCreateForm = ref(false);
const showCostumeInstall = ref(false);
// Switchyard is the primary place to interact with wings — default view.
const currentView = ref<'switchyard' | 'wings' | 'archives' | 'costumes' | 'quality' | 'api'>('switchyard');
const installedCostumesList = ref<InstanceType<typeof InstalledCostumesList> | null>(null);
const districtToDelete = ref<string | null>(null);
// Order districts: closed ones first, then the open one last
const orderedDistricts = computed(() => {
  if (!selectedWing.value) {
    return wings.value;
  }

  const closed = wings.value.filter(d => d.name !== selectedWing.value);
  const open = wings.value.find(d => d.name === selectedWing.value);

  return open ? [...closed, open] : wings.value;
});

async function loadDistricts() {
  try {
    loading.value = true;
    error.value = null;
    const state = await callMCPThrone('lair_get_state', {});
    wings.value = state.wings;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Unknown error';
  } finally {
    loading.value = false;
  }
}

function toggleDistrict(name: string) {
  selectedWing.value = selectedWing.value === name ? null : name;
}

async function handleDistrictCreated() {
  showCreateForm.value = false;
  await loadDistricts(); // Refresh list
}

function showDeleteDialog(wingName: string) {
  districtToDelete.value = wingName;
}

async function handleDistrictDeleted() {
  // Close the dialog
  districtToDelete.value = null;

  // If the deleted wing was selected, clear selection
  if (selectedWing.value === districtToDelete.value) {
    selectedWing.value = null;
  }

  // Refresh wings list
  await loadDistricts();
}

async function handleCostumeInstalled() {
  showCostumeInstall.value = false;
  // Refresh the installed costumes list
  if (installedCostumesList.value) {
    await installedCostumesList.value.loadCostumes();
  }
}

onMounted(async () => {
  await loadDistricts();
  const wingParam = route?.params?.wingName;
  if (wingParam && typeof wingParam === 'string') {
    currentView.value = 'wings';
    selectedWing.value = wingParam;
  }
});
</script>

<style scoped>
.lair-overview {
  padding: 20px;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.actions {
  display: flex;
  gap: 12px;
  align-items: center;
}

.view-tabs {
  display: flex;
  gap: 4px;
  border: 1px solid #ddd;
  border-radius: 4px;
  padding: 2px;
  background: #f5f5f5;
}

.tab-button {
  padding: 8px 16px;
  background: transparent;
  color: #666;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  font-weight: 500;
  transition: all 0.2s;
}

.tab-button:hover {
  background: #e0e0e0;
  color: #333;
}

.tab-button.active {
  background: #1976d2;
  color: white;
}

.header button:not(.tab-button) {
  padding: 10px 20px;
  background-color: #1976d2;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 600;
}

.header button:not(.tab-button):hover {
  background-color: #1565c0;
}

.districts-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 20px;
  margin-top: 20px;
}

.wing-card {
  border: 1px solid #ddd;
  border-radius: 8px;
  padding: 16px;
  background-color: #f9f9f9;
  cursor: pointer;
  transition: all 0.2s;
}

.wing-card:hover {
  background-color: #f0f0f0;
}

.wing-card.wing-selected {
  grid-column: 1 / -1;
  cursor: default;
  background-color: transparent;
  border: none;
  padding: 0;
}

.wing-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.wing-header.clickable {
  cursor: pointer;
}

.wing-header h3 {
  margin: 0 0 8px 0;
  color: #333;
}

.path {
  font-family: monospace;
  font-size: 0.9em;
  color: #666;
  margin: 0;
}

.wing-header-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.delete-wing-btn {
  padding: 4px 12px;
  background: none;
  border: 1px solid #ffcdd2;
  border-radius: 4px;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  color: #d32f2f;
  transition: all 0.2s;
}

.delete-wing-btn:hover {
  background: #ffebee;
  border-color: #ef9a9a;
}

.close-wing-btn {
  padding: 4px 12px;
  background: #f5f5f5;
  border: 1px solid #ddd;
  border-radius: 4px;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  color: #666;
  transition: all 0.2s;
  flex-shrink: 0;
}

.close-wing-btn:hover {
  background: #e0e0e0;
  color: #333;
  border-color: #bbb;
}

.costumes-view {
  padding: 20px;
  background: #f9f9f9;
  border-radius: 8px;
  border: 1px solid #ddd;
}

.costumes-actions {
  margin-bottom: 16px;
}

.install-btn {
  padding: 10px 20px;
  background-color: #1976d2;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 600;
}

.install-btn:hover {
  background-color: #1565c0;
}

.costumes-info {
  color: #666;
  font-size: 14px;
  margin: 0;
}
</style>
