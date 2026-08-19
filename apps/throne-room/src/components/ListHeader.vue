<template>
  <div class="list-header">
    <h3><slot /></h3>
    <button @click="onRefresh" :disabled="loading" class="refresh-btn">
      {{ loading ? 'Loading...' : 'Refresh' }}
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * ListHeader Component
 *
 * A reusable header component for list views that displays a title
 * and a refresh button with loading state.
 *
 * @component
 */

/**
 * Props:
 * @prop {boolean} loading - Whether the list is currently loading
 */
const props = withDefaults(defineProps<{
  loading?: boolean;
}>(), {
  loading: false
});

/**
 * Events:
 * @event refresh - Emitted when refresh button is clicked
 */
const emit = defineEmits<{
  refresh: [];
}>();

function onRefresh() {
  if (!props.loading) {
    emit('refresh');
  }
}
</script>

<style scoped>
.list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.list-header h3 {
  margin: 0;
}

.refresh-btn {
  padding: 8px 16px;
  background: #f5f5f5;
  border: 1px solid #ddd;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
}

.refresh-btn:hover:not(:disabled) {
  background: #e0e0e0;
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
