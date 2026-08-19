<template>
  <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]">
    <div class="bg-white rounded-lg p-6 max-w-[500px] w-[90%] shadow-lg">
      <h3 class="mt-0 mb-4" :class="{ danger: variant === 'danger', 'text-red-700': variant === 'danger' }">
        {{ title }}
      </h3>

      <div class="mb-5">
        <slot></slot>
      </div>

      <div v-if="error" class="error p-3 bg-red-50 border border-red-200 rounded text-red-800 mb-5">
        {{ error }}
      </div>

      <div class="flex gap-3 justify-end">
        <Button variant="outline" @click="$emit('cancel')" :disabled="processing">
          Cancel
        </Button>
        <Button
          :variant="variant === 'danger' ? 'destructive' : 'default'"
          @click="$emit('confirm')"
          :disabled="processing"
        >
          {{ processing ? confirmingLabel : confirmLabel }}
        </Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Button } from '@minions/ui';

defineProps<{
  title: string;
  confirmLabel: string;
  confirmingLabel: string;
  processing: boolean;
  error?: string | null;
  variant?: 'danger' | 'warning' | 'default';
}>();

defineEmits<{
  confirm: [];
  cancel: [];
}>();
</script>
