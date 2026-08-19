<template>
  <div v-if="route.path.startsWith('/design')" style="height:100vh">
    <RouterView />
  </div>

  <div v-else-if="route.path.startsWith('/docs')" style="height:100vh">
    <RouterView />
  </div>

  <div v-else-if="route.path.startsWith('/plan')" style="height:100vh;display:flex;flex-direction:column;overflow:hidden">
    <div style="display:flex;align-items:center;background:#111827;border-bottom:2px solid #1f2937;padding:0 16px;flex-shrink:0;height:40px">
      <span style="font-size:11px;font-weight:700;color:#60a5fa;letter-spacing:.08em">LIVING COSMOS</span>
      <span style="font-size:10px;color:#374151;margin-left:8px">Plan Overview</span>
      <nav style="margin-left:auto;display:flex;align-items:center;gap:4px">
        <RouterLink to="/gsd" class="nav-link">GSD</RouterLink>
        <RouterLink to="/flow" class="nav-link">Flow</RouterLink>
        <span style="width:1px;height:16px;background:#1f2937;margin:0 4px"></span>
        <button class="commit-btn"
          :class="{ 'commit-btn--ok': commitStatus==='ok', 'commit-btn--err': commitStatus==='err' }"
          :disabled="committing"
          :title="commitStatus==='err' ? commitError : ''"
          @click="doCommit">
          {{ committing ? 'SAVING…' : commitStatus==='ok' ? '✓ SAVED' : commitStatus==='err' ? '✕ FAILED' : '↑ COMMIT' }}
        </button>
        <span style="width:1px;height:16px;background:#1f2937;margin:0 4px"></span>
        <RouterLink to="/" class="nav-link dim">← Throne Room</RouterLink>
      </nav>
    </div>
    <div style="flex:1;overflow:hidden">
      <RouterView />
    </div>
  </div>

  <div v-else-if="route.path.startsWith('/gsd')" style="height:100vh;display:flex;flex-direction:column;overflow:hidden">
    <div style="display:flex;align-items:center;background:#040302;border-bottom:1px solid rgba(212,160,23,.12);padding:0 16px;flex-shrink:0;height:40px">
      <span style="font-size:13px;font-weight:700;color:#d4a017;font-family:'Georgia',serif;margin-right:2px">J</span>
      <span style="font-size:11px;font-weight:700;color:#6b5a2a;letter-spacing:.08em;margin-left:6px">GSD ORACLE</span>
      <nav style="margin-left:auto;display:flex;align-items:center;gap:4px">
        <RouterLink to="/plan" class="nav-link oracle">Plan</RouterLink>
        <RouterLink to="/flow" class="nav-link oracle">Flow</RouterLink>
        <span style="width:1px;height:16px;background:rgba(212,160,23,.1);margin:0 4px"></span>
        <button class="commit-btn"
          :class="{ 'commit-btn--ok': commitStatus==='ok', 'commit-btn--err': commitStatus==='err' }"
          :disabled="committing"
          :title="commitStatus==='err' ? commitError : ''"
          @click="doCommit">
          {{ committing ? 'SAVING…' : commitStatus==='ok' ? '✓ SAVED' : commitStatus==='err' ? '✕ FAILED' : '↑ COMMIT' }}
        </button>
        <span style="width:1px;height:16px;background:rgba(212,160,23,.1);margin:0 4px"></span>
        <RouterLink to="/" class="nav-link oracle dim">← Throne Room</RouterLink>
      </nav>
    </div>
    <RouterView style="flex:1" />
  </div>

  <div v-else-if="route.path.startsWith('/flow')" style="height:100vh;display:flex;flex-direction:column;overflow:hidden">
    <div style="display:flex;align-items:center;background:#05080f;border-bottom:1px solid #0f172a;padding:0 16px;flex-shrink:0;height:40px">
      <span style="font-size:11px;font-weight:700;color:#818cf8;letter-spacing:.08em">SYSTEM FLOW</span>
      <span style="font-size:10px;color:#475569;margin-left:8px">River View</span>
      <nav style="margin-left:auto;display:flex;align-items:center;gap:4px">
        <RouterLink to="/plan" class="nav-link flow">Plan</RouterLink>
        <RouterLink to="/gsd" class="nav-link flow">GSD</RouterLink>
        <span style="width:1px;height:16px;background:#0f172a;margin:0 4px"></span>
        <button class="commit-btn"
          :class="{ 'commit-btn--ok': commitStatus==='ok', 'commit-btn--err': commitStatus==='err' }"
          :disabled="committing"
          :title="commitStatus==='err' ? commitError : ''"
          @click="doCommit">
          {{ committing ? 'SAVING…' : commitStatus==='ok' ? '✓ SAVED' : commitStatus==='err' ? '✕ FAILED' : '↑ COMMIT' }}
        </button>
        <span style="width:1px;height:16px;background:#0f172a;margin:0 4px"></span>
        <RouterLink to="/" class="nav-link flow dim">← Throne Room</RouterLink>
      </nav>
    </div>
    <div style="flex:1;overflow:hidden">
      <RouterView />
    </div>
  </div>

  <div v-else id="app">
    <WelcomeScreen v-if="showWelcome" @dismiss="handleWelcomeDismiss" />
    <header>
      <h1>Throne Room</h1>
      <nav class="planning-nav">
        <RouterLink to="/plan">Plan</RouterLink>
        <RouterLink to="/gsd">GSD</RouterLink>
        <RouterLink to="/flow">Flow</RouterLink>
        <RouterLink to="/movement">Movement</RouterLink>
      </nav>
      <button class="help-button" @click="showWelcome = true" title="Show welcome screen">
        ?
      </button>
    </header>
    <main>
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, RouterView, RouterLink } from 'vue-router';
import WelcomeScreen from './components/WelcomeScreen.vue';
import { usePlanOps } from './plan/usePlanOps';

const { clear: clearOps } = usePlanOps();

const route = useRoute();
const showWelcome = ref(false);

const committing = ref(false);
const commitStatus = ref<'idle' | 'ok' | 'err'>('idle');
const commitError = ref('');

// movement-trunk-safety-redesign phase 6 (final sweep): this used to call
// `movement commit` (atLair) after recording ops, to publish MAIN edits made
// via update-item/delete-subtree/etc. onto main. That's no longer needed —
// every one of those `plan` actions now commits AND publishes atomically the
// moment it's called (`Mirror.apply()`, design doc §4.5), so by the time this
// button is clicked there is nothing left uncommitted to publish. `movement
// commit`'s atLair hook itself was deleted (dead code — see
// `MovementActionGroup.ts`'s `commitAction` comment), so this is now purely
// a local "acknowledge and clear the recent-ops list" action, not a network
// call.
function doCommit() {
  if (committing.value) return;
  committing.value = true;
  commitStatus.value = 'idle';
  clearOps();
  commitStatus.value = 'ok';
  setTimeout(() => { commitStatus.value = 'idle'; }, 1500);
  committing.value = false;
}

onMounted(() => {
  const hasSeenWelcome = localStorage.getItem('welcomeScreenSeen');
  if (!hasSeenWelcome) {
    showWelcome.value = true;
  }
});

function handleWelcomeDismiss() {
  showWelcome.value = false;
  localStorage.setItem('welcomeScreenSeen', 'true');
}
</script>

<style>
#app {
  font-family: Avenir, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

header {
  text-align: center;
  border-bottom: 2px solid #333;
  padding-bottom: 20px;
  margin-bottom: 30px;
  position: relative;
}

.planning-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 12px;
}

.planning-nav a {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .06em;
  color: #666;
  text-decoration: none;
  padding: 4px 14px;
  border-radius: 4px;
  border: 1px solid #333;
  transition: all .15s;
}

.planning-nav a:hover {
  color: #aaa;
  border-color: #555;
}

.help-button {
  position: absolute;
  top: 0;
  right: 0;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: #1976d2;
  color: white;
  border: none;
  font-size: 18px;
  font-weight: bold;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.help-button:hover {
  background: #1565c0;
  transform: scale(1.1);
}

main {
  margin-top: 20px;
}

/* Planning view nav links */
.nav-link {
  font-size: 10px;
  color: #64748b;
  text-decoration: none;
  padding: 3px 10px;
  border-radius: 3px;
  border: 1px solid #1f2937;
  transition: color .15s;
}

.nav-link:hover {
  color: #94a3b8;
}

.nav-link.dim {
  color: #374151;
  border-color: #1f2937;
}

.nav-link.dim:hover {
  color: #64748b;
}

.nav-link.oracle {
  color: #3a3530;
  border-color: rgba(212,160,23,.1);
}

.nav-link.oracle:hover {
  color: #6b5a2a;
}

.nav-link.flow {
  color: #1e293b;
  border-color: #0f172a;
}

.nav-link.flow:hover {
  color: #475569;
}

/* Commit button */
.commit-btn {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .06em;
  color: #4ade80;
  padding: 3px 10px;
  border-radius: 3px;
  border: 1px solid rgba(74, 222, 128, .25);
  background: rgba(74, 222, 128, .06);
  cursor: pointer;
  font-family: inherit;
  transition: background .15s, color .15s, border-color .15s;
}

.commit-btn:hover:not(:disabled) {
  background: rgba(74, 222, 128, .12);
}

.commit-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.commit-btn--ok {
  color: #4ade80;
  border-color: rgba(74, 222, 128, .5);
  background: rgba(74, 222, 128, .12);
}

.commit-btn--err {
  color: #f87171;
  border-color: rgba(248, 113, 113, .4);
  background: rgba(248, 113, 113, .08);
}
</style>
