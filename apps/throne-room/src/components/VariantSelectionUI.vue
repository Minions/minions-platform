<template>
  <div class="variant-selection">
    <div class="question-text">{{ question.question }}</div>

    <div class="variants-grid">
      <div v-for="variant in variants" :key="variant.id" class="variant-card">
        <h3 class="variant-name">{{ variant.name }}</h3>
        <p v-if="variant.description" class="variant-description">{{ variant.description }}</p>

        <div class="variant-preview" v-html="variant.html"></div>

        <div class="features-section">
          <h4 class="features-heading">Features</h4>
          <label
            v-for="feature in variant.features"
            :key="feature.id"
            class="feature-label"
          >
            <input
              type="checkbox"
              :value="`${variant.id}:${feature.id}`"
              v-model="selectedFeatureKeys"
            />
            <span class="feature-name">{{ feature.name }}</span>
            <span v-if="feature.description" class="feature-description">{{ feature.description }}</span>
          </label>
        </div>
      </div>
    </div>

    <div v-if="error" class="error">{{ error }}</div>

    <div class="actions">
      <button class="proceed-btn" :disabled="submitting" @click="proceed">
        <span v-if="submitting">Proceeding...</span>
        <span v-else>Proceed with this combination</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { callMCPThroneRaw } from '../api/cabinet';
import type { AskResult } from '@minions/mcp-types';
import type { Question } from '../types/question';
import type { VariantsContent } from '@minions/mcp-types';

const props = defineProps<{ question: Question }>();
const emit = defineEmits<{ answered: [questionId: string] }>();

const submitting = ref(false);
const error = ref<string | null>(null);
const selectedFeatureKeys = ref<string[]>([]);

const variantsContent = computed<VariantsContent | null>(() => {
  const c = props.question.content;
  if (!c || c.type !== 'variants') return null;
  try {
    const parsed = JSON.parse(c.content);
    if (parsed && parsed.__type === 'variants') return parsed as VariantsContent;
  } catch {
    // invalid JSON
  }
  return null;
});

const variants = computed(() => variantsContent.value?.variants ?? []);

watch(
  variants,
  (newVariants) => {
    selectedFeatureKeys.value = newVariants.flatMap((v) =>
      v.features.map((f) => `${v.id}:${f.id}`)
    );
  },
  { immediate: true }
);

async function proceed() {
  try {
    submitting.value = true;
    error.value = null;

    const selectedFeatures = variants.value.flatMap((v) =>
      v.features
        .filter((f) => selectedFeatureKeys.value.includes(`${v.id}:${f.id}`))
        .map((f) => ({ variantId: v.id, featureId: f.id }))
    );

    await callMCPThroneRaw<AskResult>('ask', {
      action: 'answer',
      questionId: props.question.id,
      answer: JSON.stringify({ selectedFeatures }),
    });

    emit('answered', props.question.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to proceed';
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.variant-selection {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.question-text {
  padding: 16px;
  background: #fff3e0;
  border-left: 4px solid #ff9800;
  border-radius: 4px;
  font-size: 16px;
  line-height: 1.5;
}

.variants-grid {
  display: flex;
  gap: 16px;
  overflow-x: auto;
}

.variant-card {
  flex: 1 1 0;
  min-width: 280px;
  border: 2px solid #ddd;
  border-radius: 8px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.variant-name {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #1976d2;
}

.variant-description {
  margin: 0;
  font-size: 13px;
  color: #666;
  font-style: italic;
}

.variant-preview {
  border: 1px solid #e0e0e0;
  border-radius: 4px;
  padding: 16px;
  background: #fafafa;
  min-height: 80px;
  overflow: auto;
  font-size: 14px;
}

.features-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.features-heading {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
  color: #555;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.feature-label {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 14px;
  cursor: pointer;
  padding: 4px 0;
}

.feature-label input[type='checkbox'] {
  margin-top: 2px;
  flex-shrink: 0;
  cursor: pointer;
  width: 14px;
  height: 14px;
}

.feature-name {
  font-weight: 500;
}

.feature-description {
  color: #888;
  font-size: 12px;
  margin-left: 4px;
}

.error {
  padding: 12px;
  background: #fee;
  border: 1px solid #fcc;
  border-radius: 4px;
  color: #c00;
}

.actions {
  display: flex;
  justify-content: flex-end;
}

.proceed-btn {
  padding: 12px 24px;
  background: #1976d2;
  color: white;
  border: none;
  border-radius: 4px;
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
}

.proceed-btn:hover:not(:disabled) {
  background: #1565c0;
}

.proceed-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
