<template>
  <ConfirmationDialog
    title="Demolish Wing"
    confirmLabel="Demolish Wing"
    confirmingLabel="Demolishing..."
    :processing="deleting"
    :error="error"
    variant="danger"
    @confirm="handleDelete"
    @cancel="$emit('cancel')"
  >
    <p>Are you sure you want to demolish wing <strong>{{ wingName }}</strong>?</p>
    <p>This will:</p>
    <ul>
      <li>Remove all work worktrees</li>
      <li>Remove all private worktrees</li>
      <li>Delete the wing directory</li>
    </ul>
    <p class="warning">This action cannot be undone.</p>
  </ConfirmationDialog>
</template>

<script setup lang="ts">
/**
 * WingDeleteDialog Component
 *
 * Confirmation dialog for deleting a wing.
 * Displays warning, calls Cabinet MCP server to delete the wing,
 * and removes all associated worktrees.
 *
 * @component
 */
import { ref } from 'vue';
import { callMCPConductor } from '../api/cabinet';
import ConfirmationDialog from './ConfirmationDialog.vue';

/**
 * Props:
 * @prop {string} wingName - Name of the wing to delete
 */
const props = defineProps<{
  wingName: string;
}>();

/**
 * Events:
 * @event deleted - Emitted when wing successfully deleted
 * @event cancel - Emitted when user cancels the delete operation
 */
const emit = defineEmits<{
  deleted: [];
  cancel: [];
}>();

const deleting = ref(false);
const error = ref<string | null>(null);

/**
 * Handle delete confirmation
 * Calls MCP server to delete the wing
 */
async function handleDelete() {
  try {
    deleting.value = true;
    error.value = null;

    await callMCPConductor('wings', {
      action: 'delete',
      name: props.wingName
    });

    emit('deleted');
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to demolish wing';
  } finally {
    deleting.value = false;
  }
}
</script>

<style scoped>
.warning {
  color: #d32f2f;
  font-weight: 600;
}

p {
  margin: 12px 0;
  line-height: 1.5;
}

ul {
  margin: 12px 0;
  padding-left: 24px;
}

li {
  margin: 6px 0;
  line-height: 1.5;
}
</style>
