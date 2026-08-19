<template>
  <div class="lair-card">
    <div class="lair-card-header">
      <h3 class="lair-name">{{ lair.name }}</h3>
      <span :class="['status-chip', statusClass]">{{ statusLabel }}</span>
    </div>
    <div class="lair-card-footer">
      <button
        v-if="lair.status === 'offline'"
        class="btn btn-start"
        @click="$emit('start', lair.root)"
      >
        Start
      </button>
      <button
        v-else
        class="btn btn-stop"
        @click="$emit('stop', lair.root)"
      >
        Stop
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

export interface LairInfo {
  name: string;
  root: string;
  port: number;
  status: 'working' | 'offline' | 'starting';
}

const props = defineProps<{ lair: LairInfo }>();
defineEmits<{
  start: [root: string];
  stop: [root: string];
}>();

const statusLabel = computed(() => {
  switch (props.lair.status) {
    case 'working': return 'working...';
    case 'starting': return 'starting...';
    default: return 'offline...';
  }
});

const statusClass = computed(() => {
  switch (props.lair.status) {
    case 'working': return 'status-working';
    case 'starting': return 'status-starting';
    default: return 'status-offline';
  }
});
</script>

<style scoped>
.lair-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  transition: border-color 0.2s;
}
.lair-card:hover {
  border-color: var(--color-accent);
}
.lair-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.lair-name {
  font-size: 1rem;
  font-weight: 600;
  color: var(--color-text);
}
.status-chip {
  font-size: 0.75rem;
  padding: 3px 10px;
  border-radius: 12px;
  font-weight: 500;
}
.status-working {
  background: rgba(76, 175, 80, 0.15);
  color: var(--color-success);
  border: 1px solid rgba(76, 175, 80, 0.3);
}
.status-offline {
  background: rgba(255, 152, 0, 0.1);
  color: var(--color-warning);
  border: 1px solid rgba(255, 152, 0, 0.2);
}
.status-starting {
  background: rgba(124, 92, 191, 0.15);
  color: var(--color-accent-hover);
  border: 1px solid rgba(124, 92, 191, 0.3);
}
.lair-card-footer {
  display: flex;
  justify-content: flex-end;
}
.btn {
  padding: 6px 16px;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  border: none;
  transition: background 0.2s;
}
.btn-start {
  background: rgba(76, 175, 80, 0.2);
  color: var(--color-success);
  border: 1px solid rgba(76, 175, 80, 0.4);
}
.btn-start:hover {
  background: rgba(76, 175, 80, 0.35);
}
.btn-stop {
  background: rgba(244, 67, 54, 0.15);
  color: var(--color-error);
  border: 1px solid rgba(244, 67, 54, 0.3);
}
.btn-stop:hover {
  background: rgba(244, 67, 54, 0.25);
}
</style>
