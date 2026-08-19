<template>
  <div class="interaction-detail">
    <div class="detail-header">
      <button @click="$emit('close')" class="back-btn">
        ← Back to List
      </button>
      <button @click="copyRawJSON" class="copy-json-btn">
        Copy Raw JSON
      </button>
    </div>

    <div class="detail-content">
      <section class="request-section">
        <h4>Request</h4>

        <div class="request-user-prompt">
          <label>User Prompt:</label>
          <pre>{{ interaction.userPrompt }}</pre>
        </div>

        <details class="request-full">
          <summary>Full Request (with context)</summary>
          <pre>{{ interaction.fullRequest }}</pre>
        </details>
      </section>

      <section class="response-section">
        <h4>Response ({{ interaction.responseBlocks.length }} blocks)</h4>

        <div
          v-for="(block, index) in interaction.responseBlocks"
          :key="index"
          class="response-block"
          :class="`block-${block.type}`"
        >
          <div class="block-header">
            <span class="block-type">{{ block.type }}</span>
            <span v-if="block.timestamp" class="block-time">
              {{ formatTime(block.timestamp) }}
            </span>
          </div>

          <div class="block-content">
            <!-- Reasoning block -->
            <details v-if="block.type === 'reasoning'" class="reasoning">
              <summary>Reasoning</summary>
              <pre>{{ block.content }}</pre>
            </details>

            <!-- Tool use block -->
            <div v-else-if="block.type === 'tool_use'" class="tool-use">
              <div class="tool-name">Tool: <code>{{ block.name }}</code></div>
              <details>
                <summary>Input</summary>
                <pre>{{ JSON.stringify(block.input, null, 2) }}</pre>
              </details>
            </div>

            <!-- Tool result block -->
            <details v-else-if="block.type === 'tool_result'" class="tool-result">
              <summary>Result</summary>
              <pre>{{ block.content }}</pre>
            </details>

            <!-- Message block -->
            <div v-else-if="block.type === 'message'" class="message">
              <pre>{{ block.content }}</pre>
            </div>

            <!-- Init block -->
            <details v-else-if="block.type === 'init'" class="init">
              <summary>Data</summary>
              <pre>{{ block.content }}</pre>
            </details>

            <!-- Unknown block type -->
            <details v-else class="unknown">
              <summary>Raw data</summary>
              <pre>{{ JSON.stringify(block, null, 2) }}</pre>
            </details>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { MinionsGetInteractionDetailResult } from '@minions/mcp-types';

const props = defineProps<{
  interaction: MinionsGetInteractionDetailResult;
}>();

defineEmits<{
  close: [];
}>();

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

async function copyRawJSON() {
  try {
    await navigator.clipboard.writeText(
      JSON.stringify(props.interaction, null, 2)
    );
    alert('Raw JSON copied to clipboard!');
  } catch (error) {
    console.error('Failed to copy:', error);
    alert('Failed to copy to clipboard');
  }
}
</script>

<style scoped>
.interaction-detail {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: white;
}

.detail-header {
  display: flex;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid #ddd;
  background: #f5f5f5;
}

.back-btn, .copy-json-btn {
  padding: 8px 16px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
}

.back-btn {
  background: #666;
  color: white;
}

.back-btn:hover {
  background: #555;
}

.copy-json-btn {
  background: #4caf50;
  color: white;
}

.copy-json-btn:hover {
  background: #45a049;
}

.detail-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

section {
  margin-bottom: 32px;
}

section h4 {
  margin: 0 0 16px 0;
  color: #333;
  font-size: 18px;
  border-bottom: 2px solid #1976d2;
  padding-bottom: 8px;
}

.request-user-prompt {
  margin-bottom: 16px;
}

.request-user-prompt label {
  font-weight: 600;
  display: block;
  margin-bottom: 8px;
  color: #666;
}

.request-full {
  margin-top: 16px;
}

.request-full summary {
  cursor: pointer;
  font-weight: 600;
  color: #1976d2;
  padding: 8px;
  background: #f5f5f5;
  border-radius: 4px;
}

.request-full summary:hover {
  background: #e3f2fd;
}

.response-block {
  margin-bottom: 16px;
  border: 1px solid #ddd;
  border-radius: 6px;
  overflow: hidden;
}

.block-reasoning {
  border-left: 4px solid #ff9800;
}

.block-tool_use {
  border-left: 4px solid #2196f3;
}

.block-tool_result {
  border-left: 4px solid #4caf50;
}

.block-message {
  border-left: 4px solid #9c27b0;
}

.block-init {
  border-left: 4px solid #607d8b;
}

.block-header {
  display: flex;
  justify-content: space-between;
  padding: 8px 12px;
  background: #f5f5f5;
  font-size: 12px;
}

.block-type {
  font-weight: 600;
  text-transform: uppercase;
  font-family: monospace;
}

.block-time {
  color: #999;
  font-family: monospace;
}

.block-content {
  padding: 12px;
}

pre {
  margin: 0;
  padding: 12px;
  background: #f9f9f9;
  border-radius: 4px;
  overflow-x: auto;
  font-family: 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-wrap: break-word;
}

.tool-name {
  margin-bottom: 12px;
  font-weight: 600;
}

.tool-name code {
  background: #e3f2fd;
  padding: 2px 8px;
  border-radius: 3px;
  font-family: monospace;
}

details {
  margin-top: 8px;
}

details summary {
  cursor: pointer;
  padding: 6px;
  background: #f0f0f0;
  border-radius: 3px;
  font-size: 13px;
}

details summary:hover {
  background: #e0e0e0;
}

details[open] summary {
  margin-bottom: 8px;
}
</style>
