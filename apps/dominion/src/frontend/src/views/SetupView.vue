<template>
  <div class="setup">
    <header class="setup-header">
      <button class="btn-back" @click="$emit('cancel')">← Back</button>
      <h1 class="title">Add New Lair</h1>
    </header>

    <!-- Step 1: Welcome -->
    <div v-if="step === 1" class="step-content">
      <div class="step-icon">⚡</div>
      <h2>Let's set up a new lair</h2>
      <p class="step-desc">
        Provide a Git repository URL that contains a <code>configure-lair.md</code> recipe
        in its <code>meta/config/</code> branch. The Dominion will fetch it, show you what
        will be set up, and then launch a Claude agent to configure everything automatically.
      </p>
      <button class="btn-primary" @click="step = 2">Get Started</button>
    </div>

    <!-- Step 2: Config repo URL + lair name + branch -->
    <div v-else-if="step === 2" class="step-content">
      <h2>Enter Configuration Details</h2>
      <p class="step-desc">
        Point to the repository that holds the lair recipe.
        This can be the same repo as your project or a separate IT/config repo.
      </p>

      <form class="setup-form" @submit.prevent="handleSubmit">
        <div class="form-group">
          <label for="config-url">Config Repository URL</label>
          <input
            id="config-url"
            v-model="configUrl"
            type="url"
            placeholder="https://github.com/acme/my-project.git"
            required
            :disabled="isLoading"
          />
          <p class="field-hint">
            The repo that contains <code>configure-lair.md</code> on the config branch.
          </p>
        </div>

        <div class="form-group">
          <label for="lair-name">Lair Name <span class="optional">(optional)</span></label>
          <input
            id="lair-name"
            v-model="lairName"
            type="text"
            placeholder="Auto-detected from URL"
            :disabled="isLoading"
          />
        </div>

        <div class="form-group">
          <label for="config-branch">Config Branch <span class="optional">(optional)</span></label>
          <input
            id="config-branch"
            v-model="configBranch"
            type="text"
            placeholder="lair-default"
            :disabled="isLoading"
          />
          <p class="field-hint">
            Branch suffix under <code>meta/config/</code>. Defaults to <code>lair-default</code>.
          </p>
        </div>

        <details class="private-repo">
          <summary>Private repository?</summary>
          <div class="form-group">
            <label for="access-token">Personal Access Token</label>
            <input
              id="access-token"
              v-model="accessToken"
              type="password"
              placeholder="ghp_..."
              :disabled="isLoading"
            />
            <p class="field-hint">
              GitHub: Settings → Developer settings → Personal access tokens → Classic.
              Needs <code>repo</code> scope.
            </p>
          </div>
        </details>

        <div v-if="errorMsg" class="error-msg">{{ errorMsg }}</div>

        <div class="form-actions">
          <button type="button" class="btn-secondary" @click="step = 1" :disabled="isLoading">
            Back
          </button>
          <button type="submit" class="btn-primary" :disabled="isLoading || !configUrl">
            <span v-if="isLoading" class="spinner">⟳</span>
            {{ isLoading ? currentStatus : 'Fetch Recipe' }}
          </button>
        </div>
      </form>
    </div>

    <!-- Step 3: Recipe preview -->
    <div v-else-if="step === 3" class="step-content recipe-step">
      <h2>Configuration Recipe</h2>
      <p class="step-desc">
        <template v-if="recipeFound">
          Found <code>configure-lair.md</code> on branch
          <code>meta/config/{{ effectiveBranch }}</code>.
          Review the recipe, then launch the setup agent.
        </template>
        <template v-else>
          Recipe not found — cannot continue.
          Check the repository URL and branch name, then go back and try again.
        </template>
      </p>

      <div v-if="recipeFound" class="recipe-preview">
        <pre class="recipe-content">{{ recipe }}</pre>
      </div>

      <div class="form-actions">
        <button class="btn-secondary" @click="step = 2">← Back</button>
        <button v-if="recipeFound" class="btn-primary" @click="handleLaunch">
          Launch Setup Agent →
        </button>
      </div>
    </div>

    <!-- Step 4: Bootstrap progress (SSE) -->
    <div v-else-if="step === 4" class="step-content plan-step">
      <h2>Setting Up Lair…</h2>
      <p class="step-desc">Bootstrapping the lair and launching the setup agent.</p>

      <div class="progress-log">
        <div
          v-for="(msg, i) in progressLog"
          :key="i"
          class="progress-line"
          :class="{ success: msg.startsWith('✓'), error: msg.startsWith('✗') }"
        >{{ msg }}</div>
        <div v-if="isBootstrapping" class="progress-line muted">
          <span class="spinner">⟳</span> Working…
        </div>
      </div>

      <div v-if="bootstrapError" class="error-msg">{{ bootstrapError }}</div>
    </div>

    <!-- Step 5: Agent running / done -->
    <div v-else-if="step === 5" class="step-content plan-step">
      <h2>
        <span v-if="agentStatus === 'running'">Agent Configuring…</span>
        <span v-else-if="agentStatus === 'done'">Setup Complete ✓</span>
        <span v-else>Setup Failed ✗</span>
      </h2>

      <p class="step-desc">
        <template v-if="agentStatus === 'running'">
          The Claude setup agent is running in the background, configuring
          <strong>{{ createdLairName }}</strong>.
          This may take several minutes (includes a full build).
        </template>
        <template v-else-if="agentStatus === 'done'">
          <strong>{{ createdLairName }}</strong> has been fully configured and is ready to use.
        </template>
        <template v-else>
          The setup agent exited with an error (code {{ agentExitCode }}).
          See the log below for details.
        </template>
      </p>

      <!-- Polling indicator -->
      <div v-if="agentStatus === 'running'" class="polling-row">
        <span class="spinner">⟳</span>
        <span class="muted-text">Checking status every 5 s…</span>
      </div>

      <!-- Agent log -->
      <div v-if="agentLog" class="progress-log agent-log">
        <div
          v-for="(line, i) in agentLogLines"
          :key="i"
          class="progress-line"
          :class="{ 'error': line.startsWith('[stderr]') }"
        >{{ line }}</div>
      </div>

      <!-- Throne Room link once cabinet is confirmed running -->
      <template v-if="cabinetPort !== null && agentStatus !== 'running'">
        <div class="launch-status" :class="agentStatus === 'done' ? 'success' : 'error-text'">
          Cabinet on port {{ cabinetPort }}
        </div>
        <a
          :href="`http://localhost:${cabinetPort}`"
          target="_blank"
          rel="noopener"
          class="btn-secondary btn-link"
        >
          Open Throne Room →
        </a>
      </template>

      <button class="btn-primary" @click="$emit('done')">View Dashboard</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue';

defineEmits<{
  cancel: [];
  done: [];
}>();

// ── Form state ────────────────────────────────────────────────────────────────
const step          = ref(1);
const configUrl     = ref('');
const lairName      = ref('');
const configBranch  = ref('');
const accessToken   = ref('');
const isLoading     = ref(false);
const errorMsg      = ref('');
const currentStatus = ref('');

// ── Recipe state ──────────────────────────────────────────────────────────────
const recipe      = ref('');
const recipeFound = ref(false);

// ── Lair / bootstrap state ────────────────────────────────────────────────────
const createdLairName = ref('');
const createdLairRoot = ref('');
const progressLog     = ref<string[]>([]);
const isBootstrapping = ref(false);
const bootstrapError  = ref('');
const cabinetPort     = ref<number | null>(null);

// ── Agent status (polling) ────────────────────────────────────────────────────
const agentStatus   = ref<'running' | 'done' | 'error'>('running');
const agentExitCode = ref<number | null>(null);
const agentLog      = ref('');
let   pollTimer: ReturnType<typeof setInterval> | null = null;

const agentLogLines = computed(() => agentLog.value.split('\n').filter(l => l.trim()));

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});

// ── Derived values ────────────────────────────────────────────────────────────
const effectiveBranch = computed(() => configBranch.value.trim() || 'lair-default');

const derivedName = computed(() => {
  if (lairName.value.trim()) return lairName.value.trim();
  if (!configUrl.value) return '';
  const segment = configUrl.value.trim().split('/').pop() ?? '';
  return segment.replace(/\.git$/, '');
});

// ── Step 2 → 3: fetch recipe ──────────────────────────────────────────────────
async function handleSubmit(): Promise<void> {
  errorMsg.value = '';
  isLoading.value = true;

  try {
    const name = derivedName.value || 'my-lair';

    // Register the lair entry (gets us a lairRoot + port)
    currentStatus.value = 'Creating lair entry…';
    const createRes = await fetch('/api/setup/create-lair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!createRes.ok) {
      const d = await createRes.json() as { error?: string };
      throw new Error(d.error ?? 'Failed to create lair entry');
    }
    const { lairRoot } = await createRes.json() as { lairRoot: string };
    createdLairRoot.value = lairRoot;
    createdLairName.value = name;

    // Clone the config repo, read configure-lair.md, delete clone
    currentStatus.value = 'Fetching recipe…';
    const recipeRes = await fetch('/api/setup/fetch-recipe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        configUrl: configUrl.value.trim(),
        configBranch: effectiveBranch.value,
        token: accessToken.value || undefined,
      }),
    });
    if (!recipeRes.ok) {
      const d = await recipeRes.json() as { error?: string };
      throw new Error(d.error ?? 'Failed to fetch recipe');
    }
    const rd = await recipeRes.json() as { found: boolean; recipe: string | null; error?: string };
    recipeFound.value = rd.found;
    recipe.value = rd.recipe ?? '';
    step.value = 3;
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    isLoading.value = false;
    currentStatus.value = '';
  }
}

// ── Step 3 → 4 → 5: bootstrap + poll ─────────────────────────────────────────
async function handleLaunch(): Promise<void> {
  progressLog.value = [];
  bootstrapError.value = '';
  isBootstrapping.value = true;
  step.value = 4;

  try {
    const response = await fetch('/api/setup/run-recipe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lairRoot: createdLairRoot.value, recipe: recipe.value }),
    });

    if (!response.ok || !response.body) {
      const d = await response.json() as { error?: string };
      throw new Error(d.error ?? 'Bootstrap failed');
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const event = JSON.parse(line.slice(6)) as {
          type: string;
          message?: string;
          cabinetPort?: number;
        };
        if (event.type === 'progress' && event.message) {
          progressLog.value.push(event.message);
        } else if (event.type === 'error' && event.message) {
          bootstrapError.value = event.message;
          isBootstrapping.value = false;
          return;
        } else if (event.type === 'done') {
          cabinetPort.value = event.cabinetPort ?? null;
          isBootstrapping.value = false;
          step.value = 5;
          startPolling();
          return;
        }
      }
    }
  } catch (err) {
    bootstrapError.value = err instanceof Error ? err.message : String(err);
  } finally {
    isBootstrapping.value = false;
  }
}

function startPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  agentStatus.value = 'running';

  // Poll immediately then every 5 s
  void pollAgentStatus();
  pollTimer = setInterval(() => { void pollAgentStatus(); }, 5000);
}

async function pollAgentStatus(): Promise<void> {
  try {
    const res = await fetch(
      `/api/setup/agent-status?lairRoot=${encodeURIComponent(createdLairRoot.value)}`
    );
    if (!res.ok) return;
    const data = await res.json() as {
      found: boolean;
      running: boolean;
      done: boolean;
      success: boolean;
      exitCode: number | null;
      log: string;
    };
    if (!data.found) return;
    agentLog.value = data.log ?? '';
    if (data.done) {
      agentStatus.value   = data.success ? 'done' : 'error';
      agentExitCode.value = data.exitCode;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }
  } catch {
    // Swallow network errors — will retry on next tick
  }
}
</script>

<style scoped>
.setup {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.setup-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px 32px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
}

.btn-back {
  background: none;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 0.9rem;
  padding: 4px 8px;
  border-radius: 4px;
  transition: color 0.2s;
}
.btn-back:hover { color: var(--color-text); }

.title {
  font-size: 1.2rem;
  font-weight: 600;
}

.step-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  padding: 48px 32px;
  max-width: 520px;
  margin: 0 auto;
  width: 100%;
  gap: 16px;
}

.step-icon {
  font-size: 3rem;
  margin-bottom: 8px;
}

.step-content h2 {
  font-size: 1.4rem;
  font-weight: 700;
  text-align: center;
}

.step-desc {
  color: var(--color-text-muted);
  text-align: center;
  line-height: 1.6;
  max-width: 440px;
}

.step-desc code {
  background: rgba(124, 92, 191, 0.15);
  color: var(--color-accent-hover);
  padding: 1px 5px;
  border-radius: 3px;
  font-family: monospace;
  font-size: 0.85em;
}

.setup-form {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 20px;
  margin-top: 8px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-group label {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.optional {
  font-weight: 400;
  text-transform: none;
  font-size: 0.8rem;
}

.form-group input {
  padding: 10px 14px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text);
  font-size: 0.95rem;
  transition: border-color 0.2s;
}

.form-group input:focus {
  outline: none;
  border-color: var(--color-accent);
}

.form-group input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.field-hint {
  font-size: 0.8rem;
  color: var(--color-text-muted);
  line-height: 1.4;
}

.field-hint code {
  background: rgba(124, 92, 191, 0.15);
  color: var(--color-accent-hover);
  padding: 1px 5px;
  border-radius: 3px;
  font-family: monospace;
}

.private-repo {
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 12px 16px;
}

.private-repo summary {
  cursor: pointer;
  font-size: 0.9rem;
  color: var(--color-text-muted);
  user-select: none;
}

.private-repo .form-group {
  margin-top: 12px;
}

.error-msg {
  padding: 10px 14px;
  background: rgba(244, 67, 54, 0.1);
  border: 1px solid rgba(244, 67, 54, 0.3);
  border-radius: 6px;
  color: var(--color-error);
  font-size: 0.9rem;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 8px;
}

.btn-primary {
  padding: 10px 24px;
  background: var(--color-accent);
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 0.9rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s;
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-primary:hover:not(:disabled) { background: var(--color-accent-hover); }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-secondary {
  padding: 10px 20px;
  background: transparent;
  color: var(--color-text-muted);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 0.9rem;
  cursor: pointer;
  transition: border-color 0.2s;
}

.btn-secondary:hover:not(:disabled) { border-color: var(--color-text-muted); }
.btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.spinner {
  display: inline-block;
  animation: spin 1s linear infinite;
}

/* Recipe preview */
.recipe-step {
  align-items: flex-start;
  max-width: 640px;
}

.recipe-step h2,
.recipe-step .step-desc { text-align: left; }

.recipe-preview {
  width: 100%;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
}

.recipe-content {
  padding: 16px;
  font-family: monospace;
  font-size: 0.8rem;
  line-height: 1.5;
  color: var(--color-text-muted);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 400px;
  overflow-y: auto;
  margin: 0;
}

/* Progress / agent log */
.plan-step {
  align-items: flex-start;
  max-width: 600px;
}

.plan-step h2,
.plan-step .step-desc { text-align: left; }

.progress-log {
  width: 100%;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 300px;
  overflow-y: auto;
  font-family: monospace;
  font-size: 0.82rem;
}

.agent-log { max-height: 400px; }

.progress-line {
  color: var(--color-text-muted);
  line-height: 1.4;
}

.progress-line.success    { color: var(--color-success); }
.progress-line.error      { color: var(--color-error); }
.progress-line.muted      { color: var(--color-text-muted); }

.polling-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.9rem;
}

.muted-text { color: var(--color-text-muted); }

.launch-status {
  font-size: 0.9rem;
  text-align: center;
}

.launch-status.success   { color: var(--color-success); }
.launch-status.error-text { color: var(--color-error); }

.btn-link {
  display: inline-flex;
  align-items: center;
  text-decoration: none;
  padding: 10px 20px;
}
</style>
