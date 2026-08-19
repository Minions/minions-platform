<template>
  <div class="secretary-status">
    <h2>Code Execution Secretary</h2>
    <p>Status: <span :class="statusClass">{{ statusText }}</span></p>
    <p>Last Activity: {{ formattedLastActivity }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

interface Props {
  isActive?: boolean;
  lastActivity?: string;
}

const props = withDefaults(defineProps<Props>(), {
  isActive: false,
  lastActivity: undefined,
});

const statusText = computed(() => props.isActive ? 'Active' : 'Inactive');
const statusClass = computed(() => props.isActive ? 'active' : 'inactive');
const formattedLastActivity = computed(() => {
  if (!props.lastActivity) return 'Never';
  return new Date(props.lastActivity).toLocaleString();
});
</script>

<style scoped>
.secretary-status {
  padding: 20px;
  border: 1px solid #ccc;
  border-radius: 8px;
  margin: 20px 0;
}

h2 {
  margin-top: 0;
}

.active {
  color: green;
  font-weight: bold;
}

.inactive {
  color: gray;
  font-weight: bold;
}
</style>