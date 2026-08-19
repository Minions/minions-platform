<template>
  <div class="github-auth-widget">
    <!-- Idle: not connected -->
    <div v-if="state === 'idle'" class="auth-idle">
      <button class="connect-btn" @click="startAuth" :disabled="loading">
        {{ loading ? 'Starting...' : 'Connect GitHub' }}
      </button>
      <div v-if="error" class="error">{{ error }}</div>
    </div>

    <!-- Authorizing: waiting for device code entry -->
    <div v-else-if="state === 'authorizing'" class="auth-authorizing">
      <p class="auth-instruction">
        Open the link below and enter the code to authorize:
      </p>
      <div class="user-code-display">
        <span class="user-code">{{ userCode }}</span>
        <button class="copy-btn" @click="copyCode" type="button">
          {{ copied ? 'Copied!' : 'Copy' }}
        </button>
      </div>
      <a :href="verificationUri" target="_blank" rel="noopener noreferrer" class="verify-link">
        {{ verificationUri }}
      </a>
      <p class="polling-status">Waiting for authorization...</p>
      <div v-if="error" class="error">{{ error }}</div>
    </div>

    <!-- Expired: device code timed out -->
    <div v-else-if="state === 'expired'" class="auth-expired">
      <span class="expired-msg">Authorization expired.</span>
      <button class="connect-btn" @click="startAuth" :disabled="loading">Try Again</button>
      <div v-if="error" class="error">{{ error }}</div>
    </div>

    <!-- Authorized: connected -->
    <div v-else-if="state === 'authorized'" class="auth-authorized">
      <span class="connected-label">Connected as</span>
      <span class="connected-username">@{{ connectedAs }}</span>
      <button class="disconnect-btn" @click="disconnect" :disabled="loading">Disconnect</button>
      <div v-if="error" class="error">{{ error }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onUnmounted } from 'vue';
import { callCabinetREST } from '../api/cabinet';

type AuthState = 'idle' | 'authorizing' | 'authorized' | 'expired';

const state = ref<AuthState>('idle');
const loading = ref(false);
const error = ref<string | null>(null);
const userCode = ref('');
const verificationUri = ref('');
const connectedAs = ref('');
const copied = ref(false);

let pollTimer: ReturnType<typeof setTimeout> | null = null;

function clearPollTimer() {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

onUnmounted(() => {
  clearPollTimer();
});

async function startAuth() {
  error.value = null;
  loading.value = true;
  try {
    const data = await callCabinetREST<{
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    }>('POST', '/auth/github/start');

    userCode.value = data.user_code;
    verificationUri.value = data.verification_uri;
    state.value = 'authorizing';

    schedulePoll(data.interval * 1000);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to start GitHub auth';
  } finally {
    loading.value = false;
  }
}

function schedulePoll(intervalMs: number) {
  clearPollTimer();
  pollTimer = setTimeout(() => poll(intervalMs), intervalMs);
}

async function poll(intervalMs: number) {
  try {
    const data = await callCabinetREST<{
      status: 'pending' | 'authorized' | 'expired';
      connectedAs?: string;
    }>('GET', '/auth/github/poll');

    if (data.status === 'authorized') {
      connectedAs.value = data.connectedAs ?? '';
      state.value = 'authorized';
    } else if (data.status === 'expired') {
      state.value = 'expired';
    } else {
      schedulePoll(intervalMs);
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Polling failed';
    schedulePoll(intervalMs);
  }
}

async function disconnect() {
  error.value = null;
  loading.value = true;
  try {
    await callCabinetREST('DELETE', '/auth/github/token');
    state.value = 'idle';
    connectedAs.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to disconnect';
  } finally {
    loading.value = false;
  }
}

async function copyCode() {
  try {
    await navigator.clipboard.writeText(userCode.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 2000);
  } catch {
    // fallback: select the text
  }
}
</script>

<style scoped>
.github-auth-widget {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.auth-idle,
.auth-expired {
  display: flex;
  align-items: center;
  gap: 10px;
}

.auth-authorizing {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  background: #f5f5f5;
  border: 1px solid #ddd;
  border-radius: 6px;
  max-width: 420px;
}

.auth-authorized {
  display: flex;
  align-items: center;
  gap: 10px;
}

.auth-instruction {
  margin: 0;
  font-size: 14px;
  color: #555;
}

.user-code-display {
  display: flex;
  align-items: center;
  gap: 10px;
}

.user-code {
  font-family: monospace;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 3px;
  color: #1976d2;
  background: #e3f2fd;
  padding: 6px 14px;
  border-radius: 4px;
}

.copy-btn {
  padding: 6px 14px;
  background: #1976d2;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
}

.copy-btn:hover {
  background: #1565c0;
}

.verify-link {
  font-size: 13px;
  color: #1976d2;
  word-break: break-all;
}

.polling-status {
  margin: 0;
  font-size: 13px;
  color: #888;
  font-style: italic;
}

.connected-label {
  font-size: 14px;
  color: #555;
}

.connected-username {
  font-weight: 600;
  color: #2e7d32;
  font-size: 14px;
}

.expired-msg {
  font-size: 14px;
  color: #c33;
}

.connect-btn {
  padding: 8px 18px;
  background: #24292e;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
}

.connect-btn:hover:not(:disabled) {
  background: #444d56;
}

.connect-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.disconnect-btn {
  padding: 6px 14px;
  background: white;
  color: #c33;
  border: 1px solid #fcc;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}

.disconnect-btn:hover:not(:disabled) {
  background: #fee;
}

.disconnect-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.error {
  padding: 6px 10px;
  background: #fee;
  border: 1px solid #fcc;
  border-radius: 4px;
  color: #c33;
  font-size: 13px;
}
</style>
