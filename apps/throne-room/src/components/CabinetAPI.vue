<template>
  <div class="cabinet-api">
    <h2>Cabinet MCP API</h2>

    <StateDisplay
      :loading="loading"
      :error="error"
      loading-text="Loading API information..."
    >
      <div class="api-sections">
      <!-- Tools Section -->
      <section class="api-section">
        <h3>Tools ({{ tools.length }})</h3>
        <div v-if="tools.length === 0" class="empty">No tools available</div>
        <div v-else class="items">
          <div v-for="tool in tools" :key="tool.name" class="api-item">
            <div class="item-header">
              <h4>{{ tool.name }}</h4>
              <button @click="toggleTool(tool.name)" class="invoke-btn">
                {{ expandedTool === tool.name ? 'Hide' : 'Invoke' }}
              </button>
            </div>
            <p class="description">{{ tool.description }}</p>

            <!-- Tool invocation form -->
            <div v-if="expandedTool === tool.name" class="invocation-form">
              <h5>Parameters</h5>
              <div v-if="hasParameters(tool)">
                <div v-for="(prop, propName) in tool.inputSchema.properties" :key="propName" class="param-field">
                  <label>
                    {{ propName }}
                    <span v-if="tool.inputSchema.required?.includes(propName)" class="required">*</span>
                  </label>
                  <input
                    v-model="toolParams[tool.name][propName]"
                    :placeholder="prop.description || ''"
                    :type="prop.type === 'number' ? 'number' : 'text'"
                  />
                  <small v-if="prop.description">{{ prop.description }}</small>
                </div>
              </div>
              <div v-else class="no-params">No parameters required</div>

              <button @click="invokeTool(tool)" class="execute-btn" :disabled="invoking">
                {{ invoking ? 'Executing...' : 'Execute' }}
              </button>

              <div v-if="toolResults[tool.name]" class="result">
                <h5>Result:</h5>
                <pre>{{ formatResult(toolResults[tool.name]) }}</pre>
              </div>

              <div v-if="toolErrors[tool.name]" class="result-error">
                <h5>Error:</h5>
                <pre>{{ toolErrors[tool.name] }}</pre>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Prompts Section -->
      <section class="api-section">
        <h3>Prompts ({{ prompts.length }})</h3>
        <div v-if="prompts.length === 0" class="empty">No prompts available</div>
        <div v-else class="items">
          <div v-for="prompt in prompts" :key="prompt.name" class="api-item">
            <h4>{{ prompt.name }}</h4>
            <p class="description">{{ prompt.description }}</p>
          </div>
        </div>
      </section>

      <!-- Resources Section -->
      <section class="api-section">
        <h3>Resources ({{ resources.length }})</h3>
        <div v-if="resources.length === 0" class="empty">No resources available</div>
        <div v-else class="items">
          <div v-for="resource in resources" :key="resource.uri" class="api-item">
            <h4>{{ resource.name }}</h4>
            <p class="description">{{ resource.uri }}</p>
            <small v-if="resource.mimeType">Type: {{ resource.mimeType }}</small>
          </div>
        </div>
      </section>
      </div>
    </StateDisplay>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, reactive } from 'vue';
import { listTools, listPrompts, listResources, callMCPMethod, type MCPToolInputSchema } from '../api/cabinet';
import StateDisplay from './StateDisplay.vue';

interface MCPTool {
  name: string;
  description?: string;
  inputSchema: MCPToolInputSchema;
}

interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

type ToolParamValue = string | number;

const loading = ref(true);
const error = ref<string | null>(null);
const tools = ref<MCPTool[]>([]);
const prompts = ref<MCPPrompt[]>([]);
const resources = ref<MCPResource[]>([]);
const expandedTool = ref<string | null>(null);
const invoking = ref(false);

// Store parameters for each tool
const toolParams = reactive<Record<string, Record<string, ToolParamValue>>>({});
const toolResults = reactive<Record<string, unknown>>({});
const toolErrors = reactive<Record<string, string>>({});

async function loadAPI() {
  try {
    loading.value = true;
    error.value = null;

    const [toolsList, promptsList, resourcesList] = await Promise.all([
      listTools(),
      listPrompts(),
      listResources()
    ]);

    tools.value = toolsList;
    prompts.value = promptsList;
    resources.value = resourcesList;

    // Initialize parameter objects for each tool
    toolsList.forEach(tool => {
      toolParams[tool.name] = {};
      if (tool.inputSchema?.properties) {
        Object.keys(tool.inputSchema.properties).forEach(propName => {
          toolParams[tool.name][propName] = '';
        });
      }
    });
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load API information';
  } finally {
    loading.value = false;
  }
}

function toggleTool(toolName: string) {
  if (expandedTool.value === toolName) {
    expandedTool.value = null;
  } else {
    expandedTool.value = toolName;
    // Clear previous results
    delete toolResults[toolName];
    delete toolErrors[toolName];
  }
}

function hasParameters(tool: MCPTool): boolean {
  const properties = tool.inputSchema?.properties as Record<string, unknown> | undefined;
  return !!properties && Object.keys(properties).length > 0;
}

async function invokeTool(tool: MCPTool) {
  try {
    invoking.value = true;
    delete toolErrors[tool.name];

    // Build arguments object from params
    const args: Record<string, ToolParamValue> = {};
    if (hasParameters(tool)) {
      Object.keys(tool.inputSchema.properties as Record<string, unknown>).forEach(propName => {
        const value = toolParams[tool.name][propName];
        if (value !== '') {
          args[propName] = value;
        }
      });
    }

    const result = await callMCPMethod('tools/call', {
      name: tool.name,
      arguments: args
    });

    toolResults[tool.name] = result;
  } catch (e) {
    toolErrors[tool.name] = e instanceof Error ? e.message : 'Failed to invoke tool';
  } finally {
    invoking.value = false;
  }
}

function formatResult(result: unknown): string {
  if (
    result &&
    typeof result === 'object' &&
    'content' in result &&
    Array.isArray((result as { content: unknown }).content)
  ) {
    const content = (result as { content: Array<{ text?: string }> }).content;
    const text = content[0]?.text;
    if (typeof text === 'string') {
      try {
        return JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        return text;
      }
    }
  }
  return JSON.stringify(result, null, 2);
}

onMounted(() => {
  loadAPI();
});
</script>

<style scoped>
.cabinet-api {
  padding: 20px;
}

.api-sections {
  display: flex;
  flex-direction: column;
  gap: 30px;
}

.api-section {
  border: 1px solid #ddd;
  border-radius: 8px;
  padding: 20px;
  background: #f9f9f9;
}

.api-section h3 {
  margin-top: 0;
  margin-bottom: 15px;
  color: #333;
  border-bottom: 2px solid #333;
  padding-bottom: 8px;
}

.items {
  display: flex;
  flex-direction: column;
  gap: 15px;
}

.api-item {
  background: white;
  border: 1px solid #ddd;
  border-radius: 6px;
  padding: 15px;
}

.item-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.api-item h4 {
  margin: 0;
  color: #0066cc;
  font-family: monospace;
  font-size: 16px;
}

.description {
  margin: 8px 0;
  color: #666;
}

.invoke-btn, .execute-btn {
  padding: 6px 12px;
  background: #0066cc;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
}

.invoke-btn:hover, .execute-btn:hover {
  background: #0052a3;
}

.execute-btn:disabled {
  background: #999;
  cursor: not-allowed;
}

.invocation-form {
  margin-top: 15px;
  padding-top: 15px;
  border-top: 1px solid #eee;
}

.invocation-form h5 {
  margin: 0 0 10px 0;
  color: #333;
}

.param-field {
  margin-bottom: 15px;
}

.param-field label {
  display: block;
  margin-bottom: 4px;
  font-weight: 500;
  color: #333;
}

.required {
  color: #c00;
  margin-left: 2px;
}

.param-field input {
  width: 100%;
  padding: 8px;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 14px;
  box-sizing: border-box;
}

.param-field small {
  display: block;
  margin-top: 4px;
  color: #666;
  font-size: 12px;
}

.no-params {
  color: #666;
  font-style: italic;
  margin-bottom: 15px;
}

.result, .result-error {
  margin-top: 15px;
  padding: 10px;
  background: #f5f5f5;
  border-radius: 4px;
}

.result-error {
  background: #fee;
  border: 1px solid #fcc;
}

.result h5, .result-error h5 {
  margin: 0 0 8px 0;
  color: #333;
}

.result pre, .result-error pre {
  margin: 0;
  white-space: pre-wrap;
  word-wrap: break-word;
  font-family: monospace;
  font-size: 13px;
  max-height: 400px;
  overflow: auto;
}

.result-error pre {
  color: #c00;
}
</style>
