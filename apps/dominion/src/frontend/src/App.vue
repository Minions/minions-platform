<template>
  <div class="app">
    <SetupView
      v-if="view === 'setup'"
      @cancel="view = 'dashboard'"
      @done="handleSetupDone"
    />
    <DashboardView
      v-else
      @add-lair="view = 'setup'"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import DashboardView from './views/DashboardView.vue';
import SetupView from './views/SetupView.vue';

const view = ref<'dashboard' | 'setup'>('dashboard');

function handleSetupDone(): void {
  view.value = 'dashboard';
  // DashboardView will re-fetch lairs on mount
}
</script>

<style scoped>
.app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
</style>
