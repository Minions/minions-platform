<!--
/**
 * MissionStartForm Component
 *
 * Generates a form from a mission's args schema and starts the mission.
 * Supports string, number, boolean, and array input types.
 * Validates required fields before submission.
 *
 * @component
 * @emits {started} - Emitted when mission is started, passes mission run info
 * @emits {cancel} - Emitted when the user cancels the form
 */
-->
<template>
  <div class="mission-start-form">
    <div class="form-header">
      <h3>{{ mission.name }}</h3>
      <div class="mission-meta">
        <span class="costume-badge">{{ mission.costume }}</span>
        <span v-if="mission.isLegacy" class="legacy-badge">Non-deterministic</span>
      </div>
    </div>

    <p v-if="mission.description" class="mission-description">
      {{ mission.description }}
    </p>

    <form @submit.prevent="handleSubmit">
      <!-- No args required -->
      <div v-if="!hasArgs" class="no-args">
        <p>This mission has no arguments. Click Start to run it.</p>
      </div>

      <!-- Dynamic form fields from schema -->
      <div v-else class="form-fields">
        <div
          v-for="(schema, argName) in mission.argsSchema?.properties"
          :key="argName"
          class="form-field"
        >
          <label :for="`arg-${argName}`">
            {{ argName }}
            <span v-if="isRequired(argName)" class="required">*</span>
          </label>

          <!-- Give-demo slicePath: wing + demo dropdowns -->
          <template v-if="isGiveDemo && argName === 'slicePath'">
            <div class="give-demo-selectors">
              <div class="demo-field">
                <label for="demo-wing-select">Wing</label>
                <select
                  id="demo-wing-select"
                  v-model="selectedDemoWing"
                  @change="onDemoWingChange"
                >
                  <option v-for="w in wings" :key="w.name" :value="w.name">
                    {{ w.name }}
                  </option>
                </select>
              </div>
              <div class="demo-field">
                <label for="demo-select">Demo</label>
                <select
                  id="demo-select"
                  v-model="formValues['slicePath']"
                  :disabled="loadingDemos"
                  :required="isRequired(argName)"
                >
                  <option value="" disabled>
                    {{ loadingDemos ? 'Loading demos...' : 'Select a demo' }}
                  </option>
                  <option v-for="d in demos" :key="d.slicePath" :value="d.slicePath">
                    {{ d.title }}
                  </option>
                </select>
              </div>
            </div>
          </template>

          <!-- String input -->
          <textarea
            v-else-if="schema.type === 'string' && !schema.enum"
            :id="`arg-${argName}`"
            v-model="(formValues[argName] as string)"
            :required="isRequired(argName)"
            :placeholder="schema.description"
            rows="3"
          ></textarea>

          <!-- String enum (dropdown) -->
          <select
            v-else-if="schema.type === 'string' && schema.enum"
            :id="`arg-${argName}`"
            v-model="formValues[argName]"
            :required="isRequired(argName)"
          >
            <option value="" disabled>Select {{ argName }}</option>
            <option v-for="opt in schema.enum" :key="String(opt)" :value="opt">
              {{ opt }}
            </option>
          </select>

          <!-- Number input -->
          <input
            v-else-if="schema.type === 'number'"
            :id="`arg-${argName}`"
            v-model.number="formValues[argName]"
            type="number"
            :required="isRequired(argName)"
            :placeholder="schema.description"
          />

          <!-- Boolean input -->
          <div v-else-if="schema.type === 'boolean'" class="checkbox-field">
            <input
              :id="`arg-${argName}`"
              v-model="formValues[argName]"
              type="checkbox"
            />
            <span class="checkbox-label">{{ schema.description || 'Enable' }}</span>
          </div>

          <!-- file-path[] — searchable repo picker, multiple selection -->
          <FilePathsInput
            v-else-if="schema.type === 'array' && schema.items?.type === 'file-path'"
            :id="`arg-${argName}`"
            v-model="(formValues[argName] as string[])"
            :wing-name="wingName"
            :required="isRequired(argName)"
          />

          <!-- Array input (comma-separated) -->
          <div v-else-if="schema.type === 'array'" class="array-field">
            <input
              :id="`arg-${argName}`"
              v-model="arrayInputs[argName]"
              type="text"
              :required="isRequired(argName)"
              :placeholder="schema.description || 'Enter values separated by commas'"
            />
            <small>Separate multiple values with commas</small>
          </div>

          <!-- Single file-path picker -->
          <FilePathInput
            v-else-if="schema.type === 'file-path'"
            :id="`arg-${argName}`"
            v-model="(formValues[argName] as string)"
            :wing-name="wingName"
            :required="isRequired(argName)"
          />

          <!-- Fallback for unsupported types -->
          <textarea
            v-else
            :id="`arg-${argName}`"
            v-model="(formValues[argName] as string)"
            :required="isRequired(argName)"
            :placeholder="`JSON value for ${argName}`"
            rows="3"
            class="json-textarea"
          ></textarea>

          <small v-if="schema.description && schema.type !== 'boolean'">
            {{ schema.description }}
          </small>
        </div>
      </div>

      <div v-if="error" class="error">
        {{ error }}
      </div>

      <div class="form-actions">
        <button type="button" @click="$emit('cancel')" :disabled="starting">
          Cancel
        </button>
        <button type="submit" :disabled="starting" class="start-button">
          {{ starting ? 'Starting...' : 'Start Mission' }}
        </button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { callMCPThrone, callMCPConductor } from '../api/cabinet';
import type { MissionSummary_, WingSummary, DemoSummary, MissionStartResult } from '@minions/mcp-types';
import FilePathInput from './FilePathInput.vue';
import FilePathsInput from './FilePathsInput.vue';

const props = defineProps<{
  wingName: string;
  mission: MissionSummary_;
}>();

const emit = defineEmits<{
  started: [result: { missionRunId: string; missionName: string; costume: string }];
  cancel: [];
}>();

// Form values keyed by argument name
const formValues = ref<Record<string, unknown>>({});
// Separate state for array inputs (stored as comma-separated strings)
const arrayInputs = ref<Record<string, string>>({});

const starting = ref(false);
const error = ref<string | null>(null);

// Give-demo specific state
const isGiveDemo = computed(() => props.mission.name === 'give-demo');
const wings = ref<WingSummary[]>([]);
const selectedDemoWing = ref(props.wingName);
const demos = ref<DemoSummary[]>([]);
const loadingDemos = ref(false);

/**
 * Check if the mission has any arguments
 */
const hasArgs = computed(() => {
  const schemaProps = props.mission.argsSchema?.properties;
  return schemaProps && Object.keys(schemaProps).length > 0;
});

/**
 * Check if an argument is required
 */
function isRequired(argName: string): boolean {
  return props.mission.argsSchema?.required?.includes(argName) ?? false;
}

/**
 * Initialize form values with defaults from schema
 */
function initializeForm() {
  const schema = props.mission.argsSchema;
  if (!schema?.properties) return;

  for (const [argName, propSchema] of Object.entries(schema.properties)) {
    if (propSchema.default !== undefined) {
      formValues.value[argName] = propSchema.default;
    } else if (propSchema.type === 'boolean') {
      formValues.value[argName] = false;
    } else if (propSchema.type === 'array' && propSchema.items?.type === 'file-path') {
      formValues.value[argName] = [];
    } else if (propSchema.type === 'array') {
      arrayInputs.value[argName] = '';
    } else {
      formValues.value[argName] = '';
    }
  }
}

/**
 * Build the final args object for submission
 */
function buildArgs(): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const schema = props.mission.argsSchema;
  if (!schema?.properties) return args;

  for (const [argName, propSchema] of Object.entries(schema.properties)) {
    if (propSchema.type === 'array' && propSchema.items?.type !== 'file-path') {
      // Parse comma-separated string into array
      const input = arrayInputs.value[argName];
      if (input && input.trim()) {
        args[argName] = input.split(',').map(s => s.trim()).filter(s => s);
      }
    } else {
      const value = formValues.value[argName];
      // Only include non-empty values (skip empty strings and empty arrays)
      if (value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)) {
        args[argName] = value;
      }
    }
  }

  return args;
}

/**
 * Load available demos for a wing
 */
async function loadDemos(wingName: string) {
  loadingDemos.value = true;
  try {
    const result = await callMCPConductor('demos_list', { wingName });
    demos.value = result.demos;
    // Reset slicePath selection
    formValues.value['slicePath'] = '';
  } catch {
    demos.value = [];
  } finally {
    loadingDemos.value = false;
  }
}

/**
 * Handle wing dropdown change for give-demo
 */
function onDemoWingChange() {
  loadDemos(selectedDemoWing.value);
}

/**
 * Handle form submission
 */
async function handleSubmit() {
  try {
    starting.value = true;
    error.value = null;

    const args = buildArgs();

    // For give-demo, use the selected wing instead of the props wingName
    const targetWing = isGiveDemo.value ? selectedDemoWing.value : props.wingName;

    const result = await callMCPConductor('missions', {
      action: 'start',
      wingName: targetWing,
      costume: props.mission.costume,
      mission: props.mission.name,
      args
    });

    emit('started', result as MissionStartResult);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to start mission';
  } finally {
    starting.value = false;
  }
}

// Initialize synchronously so formValues is populated before first render.
// (onMounted runs after rendering, which would leave file-path arrays undefined.)
initializeForm();

onMounted(async () => {
  // Load wings and demos for give-demo missions
  if (isGiveDemo.value) {
    try {
      const state = await callMCPThrone('lair_get_state', {});
      wings.value = state.wings;
    } catch {
      wings.value = [];
    }
    await loadDemos(selectedDemoWing.value);
  }
});
</script>

<style scoped>
.mission-start-form {
  background: white;
  border: 1px solid #ddd;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 20px;
}

.form-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.form-header h3 {
  margin: 0;
  color: #333;
}

.mission-meta {
  display: flex;
  gap: 8px;
}

.costume-badge {
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  background: #e3f2fd;
  color: #1976d2;
}

.legacy-badge {
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  background: #fff3e0;
  color: #e65100;
}

.mission-description {
  color: #666;
  margin-bottom: 20px;
  line-height: 1.5;
}

.no-args {
  padding: 20px;
  background: #f5f5f5;
  border-radius: 4px;
  text-align: center;
  color: #666;
  margin-bottom: 20px;
}

.no-args p {
  margin: 0;
}

.form-fields {
  margin-bottom: 20px;
}

.form-field {
  margin-bottom: 16px;
}

.form-field label {
  display: block;
  margin-bottom: 6px;
  font-weight: 600;
  color: #333;
}

.form-field .required {
  color: #c2185b;
  margin-left: 2px;
}

.form-field input[type="text"],
.form-field input[type="number"],
.form-field select,
.form-field textarea {
  width: 100%;
  padding: 10px;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 14px;
  font-family: inherit;
  box-sizing: border-box;
}

.form-field textarea {
  resize: vertical;
}

.form-field textarea.json-textarea {
  font-family: monospace;
}

.form-field input:focus,
.form-field select:focus,
.form-field textarea:focus {
  outline: none;
  border-color: #7b1fa2;
  box-shadow: 0 0 0 2px rgba(123, 31, 162, 0.1);
}

.form-field small {
  display: block;
  margin-top: 4px;
  color: #666;
  font-size: 12px;
}

.checkbox-field {
  display: flex;
  align-items: center;
  gap: 8px;
}

.checkbox-field input[type="checkbox"] {
  width: 18px;
  height: 18px;
  cursor: pointer;
}

.checkbox-label {
  color: #666;
}

.give-demo-selectors {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.demo-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.demo-field label {
  font-weight: 600;
  font-size: 13px;
  color: #555;
}

.demo-field select {
  width: 100%;
  padding: 10px;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 14px;
  font-family: inherit;
  box-sizing: border-box;
}

.demo-field select:focus {
  outline: none;
  border-color: #7b1fa2;
  box-shadow: 0 0 0 2px rgba(123, 31, 162, 0.1);
}

.demo-field select:disabled {
  opacity: 0.6;
  cursor: wait;
}

.array-field small {
  margin-top: 4px;
}

.error {
  padding: 12px;
  background: #fee;
  border: 1px solid #fcc;
  border-radius: 4px;
  color: #c00;
  margin-bottom: 20px;
}

.form-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

.form-actions button {
  padding: 10px 20px;
  border: none;
  border-radius: 4px;
  font-weight: 600;
  cursor: pointer;
  font-size: 14px;
}

.form-actions button[type="button"] {
  background: #f5f5f5;
  color: #333;
}

.form-actions button[type="button"]:hover:not(:disabled) {
  background: #e0e0e0;
}

.start-button {
  background: #7b1fa2;
  color: white;
}

.start-button:hover:not(:disabled) {
  background: #6a1b9a;
}

.form-actions button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
