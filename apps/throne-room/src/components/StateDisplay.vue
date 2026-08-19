<template>
  <div v-if="loading" class="loading">
    <slot name="loading">{{ loadingText }}</slot>
  </div>
  <div v-else-if="error" class="error">
    <slot name="error" :error="error">{{ error }}</slot>
  </div>
  <div v-else-if="empty" class="empty">
    <slot name="empty">{{ emptyText }}</slot>
  </div>
  <slot v-else></slot>
</template>

<script setup lang="ts">
/**
 * StateDisplay Component
 *
 * A reusable component for displaying loading, error, and empty states.
 * Provides default UI for each state with customization via props and slots.
 *
 * @component
 */

interface Props {
  /** Show loading state */
  loading?: boolean;
  /** Error message to display (null/undefined means no error) */
  error?: string | null;
  /** Show empty state */
  empty?: boolean;
  /** Custom loading text (default: "Loading...") */
  loadingText?: string;
  /** Custom empty text (default: "No items") */
  emptyText?: string;
}

withDefaults(defineProps<Props>(), {
  loading: false,
  error: null,
  empty: false,
  loadingText: 'Loading...',
  emptyText: 'No items',
});
</script>

<style scoped>
.loading,
.error,
.empty {
  padding: 40px;
  text-align: center;
  color: #666;
}

.error {
  color: #c00;
  background: #fee;
  border: 1px solid #fcc;
  border-radius: 4px;
}

.empty p {
  margin: 8px 0;
}
</style>
