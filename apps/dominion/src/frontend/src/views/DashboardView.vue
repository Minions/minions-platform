<template>
  <div class="dashboard">
    <header class="dashboard-header">
      <div class="header-left">
        <h1 class="title">The Dominion</h1>
        <span class="subtitle">Lair Management</span>
      </div>
      <button class="btn-add" @click="emit('add-lair')">
        + Add New Lair
      </button>
    </header>

    <main class="dashboard-main">
      <div v-if="lairs.length === 0" class="empty-state">
        <div class="empty-icon">⚡</div>
        <h2>No lairs configured</h2>
        <p>Add a lair to get started with your minion army.</p>
        <button class="btn-add-large" @click="emit('add-lair')">
          Add Your First Lair
        </button>
      </div>

      <div v-else class="lair-grid">
        <LairCard
          v-for="lair in lairs"
          :key="lair.root"
          :lair="lair"
          @start="handleStart"
          @stop="handleStop"
        />
      </div>
    </main>

  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import LairCard, { type LairInfo } from '../components/LairCard.vue';

const emit = defineEmits<{ 'add-lair': [] }>();

const lairs = ref<LairInfo[]>([]);
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchLairs(): Promise<void> {
  try {
    const response = await fetch('/api/lairs');
    if (!response.ok) return;
    const data = await response.json() as Array<{ name: string; root: string; port: number }>;
    const existing = new Map(lairs.value.map(l => [l.root, l.status]));
    lairs.value = data.map(l => ({
      ...l,
      status: existing.get(l.root) ?? ('offline' as const),
    }));
  } catch {
    lairs.value = [];
  }
}

async function pollStatuses(): Promise<void> {
  await Promise.all(lairs.value.map(async (lair) => {
    try {
      const res = await fetch('/api/lairs/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lairRoot: lair.root }),
      });
      if (res.ok) {
        const { running } = await res.json() as { running: boolean };
        lair.status = running ? 'working' : 'offline';
      }
    } catch {
      lair.status = 'offline';
    }
  }));
}

async function handleStart(root: string): Promise<void> {
  const lair = lairs.value.find(l => l.root === root);
  if (lair) lair.status = 'starting';
  try {
    await fetch('/api/lairs/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lairRoot: root }),
    });
    if (lair) lair.status = 'working';
  } catch {
    if (lair) lair.status = 'offline';
  }
}

async function handleStop(root: string): Promise<void> {
  try {
    await fetch('/api/lairs/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lairRoot: root }),
    });
    const lair = lairs.value.find(l => l.root === root);
    if (lair) lair.status = 'offline';
  } catch {
    // ignore
  }
}

onMounted(async () => {
  await fetchLairs();
  await pollStatuses();
  pollTimer = setInterval(() => { void pollStatuses(); }, 10_000);
});

onUnmounted(() => {
  if (pollTimer !== null) clearInterval(pollTimer);
});
</script>

<style scoped>
.dashboard {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
.dashboard-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24px 32px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
}
.header-left {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--color-text);
  letter-spacing: -0.02em;
}
.subtitle {
  font-size: 0.8rem;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.btn-add {
  padding: 8px 18px;
  background: var(--color-accent);
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 0.9rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s;
}
.btn-add:hover {
  background: var(--color-accent-hover);
}
.dashboard-main {
  flex: 1;
  padding: 32px;
}
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 80px 20px;
  text-align: center;
}
.empty-icon {
  font-size: 3rem;
}
.empty-state h2 {
  font-size: 1.4rem;
  font-weight: 600;
  color: var(--color-text);
}
.empty-state p {
  color: var(--color-text-muted);
  max-width: 360px;
}
.btn-add-large {
  margin-top: 8px;
  padding: 12px 28px;
  background: var(--color-accent);
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 1rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s;
}
.btn-add-large:hover {
  background: var(--color-accent-hover);
}
.lair-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}
</style>
