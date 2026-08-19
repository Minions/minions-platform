<template>
  <div class="switchyard">
    <StateDisplay :loading="loading" :error="error" :empty="wings.length === 0" loading-text="Surveying the yard...">
      <template #error="{ error: errorMsg }">
        <p>Error loading switchyard:</p>
        <p>{{ errorMsg }}</p>
      </template>
      <template #empty>
        <p>Your lair is empty. Build a wing to see it here.</p>
      </template>

      <table class="switchyard-table">
        <thead>
          <tr>
            <th>Wing</th>
            <th>Activity</th>
            <th>Variation</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.name">
            <td class="wing-name">{{ row.name }}</td>
            <td>
              <span v-if="row.activity.length === 0" class="dim">idle</span>
              <span v-else class="activity-pills">
                <span v-for="(a, i) in row.activity" :key="i" class="activity-pill" :class="`status-${a.status}`">
                  {{ a.client }} · {{ a.status }}
                </span>
              </span>
            </td>
            <td>
              <span v-if="row.variation" class="assign-control">
                <span class="variation-pill">
                  {{ row.variation.experimentId }} / {{ row.variation.slug }}
                  <span class="dim">({{ row.variation.status }})</span>
                </span>
                <button
                  class="unassign-button"
                  :disabled="assigningWing === row.name"
                  @click="unassignWing(row.name)"
                >
                  {{ assigningWing === row.name ? '…' : 'Unassign' }}
                </button>
              </span>
              <span v-else-if="openVariations.length === 0" class="dim">—</span>
              <span v-else class="assign-control">
                <select v-model="pendingVariation[row.name]" class="assign-select">
                  <option value="">assign to…</option>
                  <option v-for="v in openVariations" :key="v.key" :value="v.key">
                    {{ v.experimentId }} / {{ v.slug }}
                  </option>
                </select>
                <button
                  class="assign-button"
                  :disabled="!pendingVariation[row.name] || assigningWing === row.name"
                  @click="assignWing(row.name)"
                >
                  {{ assigningWing === row.name ? '…' : 'Assign' }}
                </button>
              </span>
              <div v-if="assignError[row.name]" class="assign-error">{{ assignError[row.name] }}</div>
            </td>
          </tr>
        </tbody>
      </table>
    </StateDisplay>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'WingSwitchyard' });

import { ref, computed, onMounted } from 'vue';
import { callMCPThrone, callMCPThroneRaw, getWorkRepoNames } from '../api/cabinet';
import StateDisplay from './StateDisplay.vue';

interface MinionSummary {
  id: string;
  client: string;
  status: string;
  wingName?: string;
  createdAt: string;
}

interface ExperimentVariation { slug: string; trunkBranch: string; wings: string[] }
interface ExperimentRecord { id: string; status: 'open' | 'completing' | 'resolved'; variations: ExperimentVariation[]; winner: string | null }

interface SwitchyardRow {
  name: string;
  activity: Array<{ client: string; status: string }>;
  variation: { experimentId: string; slug: string; status: string; repo: string } | null;
}

const wings = ref<string[]>([]);
const minions = ref<MinionSummary[]>([]);
const experiments = ref<Array<ExperimentRecord & { repo: string }>>([]);
const loading = ref(true);
const error = ref<string | null>(null);

// Manual "assign wing to variation" control — one pending selection and one
// in-flight/error slot per wing row, keyed by wing name.
const pendingVariation = ref<Record<string, string>>({});
const assigningWing = ref<string | null>(null);
const assignError = ref<Record<string, string>>({});

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const [state, minionsResult, repoNames] = await Promise.all([
      callMCPThrone('lair_get_state', {}),
      callMCPThroneRaw<{ minions: MinionSummary[] }>('minions', { action: 'list' }),
      getWorkRepoNames(),
    ]);
    wings.value = (state.wings as Array<{ name: string }>).map((w) => w.name);
    minions.value = minionsResult.minions;

    const perRepo = await Promise.all(
      repoNames.map((repo) =>
        callMCPThroneRaw<{ action: string; experiments: ExperimentRecord[] }>('experiments', { action: 'list', repo }).catch(
          () => ({ action: 'list', experiments: [] as ExperimentRecord[] }),
        ),
      ),
    );
    experiments.value = perRepo.flatMap((r, i) => r.experiments.map((e) => ({ ...e, repo: repoNames[i] })));
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load switchyard';
  } finally {
    loading.value = false;
  }
}

// Variations a wing can still be assigned to — only "open" experiments accept
// new assignments; completing/resolved ones are winding down.
const openVariations = computed(() => {
  const out: Array<{ key: string; repo: string; experimentId: string; slug: string }> = [];
  for (const exp of experiments.value) {
    if (exp.status !== 'open') continue;
    for (const v of exp.variations) {
      out.push({ key: `${exp.repo}|${exp.id}|${v.slug}`, repo: exp.repo, experimentId: exp.id, slug: v.slug });
    }
  }
  return out;
});

async function assignWing(wingName: string) {
  const key = pendingVariation.value[wingName];
  const target = openVariations.value.find((v) => v.key === key);
  if (!target) return;

  assigningWing.value = wingName;
  delete assignError.value[wingName];
  try {
    await callMCPThroneRaw<{ action: string }>('experiments', {
      action: 'assign-wing', id: target.experimentId, slug: target.slug, wingName, repo: target.repo,
    });
    delete pendingVariation.value[wingName];
    await load();
  } catch (e) {
    assignError.value[wingName] = e instanceof Error ? e.message : 'Failed to assign wing';
  } finally {
    assigningWing.value = null;
  }
}

async function unassignWing(wingName: string) {
  const target = rows.value.find((r) => r.name === wingName)?.variation;
  if (!target) return;

  assigningWing.value = wingName;
  delete assignError.value[wingName];
  try {
    await callMCPThroneRaw<{ action: string }>('experiments', {
      action: 'unassign-wing', id: target.experimentId, slug: target.slug, wingName, repo: target.repo,
    });
    await load();
  } catch (e) {
    assignError.value[wingName] = e instanceof Error ? e.message : 'Failed to unassign wing';
  } finally {
    assigningWing.value = null;
  }
}

// 'dead' minions are finished/terminated — a wing with only dead minions reads as idle.
const rows = computed<SwitchyardRow[]>(() => {
  const variationByWing = new Map<string, { experimentId: string; slug: string; status: string; repo: string }>();
  for (const exp of experiments.value) {
    for (const v of exp.variations) {
      for (const w of v.wings) variationByWing.set(w, { experimentId: exp.id, slug: v.slug, status: exp.status, repo: exp.repo });
    }
  }

  return wings.value
    .map((name) => ({
      name,
      activity: minions.value
        .filter((m) => m.wingName === name && m.status !== 'dead')
        .map((m) => ({ client: m.client, status: m.status })),
      variation: variationByWing.get(name) ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
});

onMounted(load);

defineExpose({ load });
</script>

<style scoped>
.switchyard {
  padding: 4px;
}

.switchyard-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.switchyard-table th {
  text-align: left;
  padding: 8px 12px;
  border-bottom: 2px solid #ddd;
  color: #666;
  font-weight: 600;
  font-size: 11px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.switchyard-table td {
  padding: 8px 12px;
  border-bottom: 1px solid #eee;
  vertical-align: top;
}

.wing-name {
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
}

.dim {
  color: #999;
}

.activity-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.activity-pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  background: #e3f2fd;
  color: #1565c0;
}

.activity-pill.status-working {
  background: #e8f5e9;
  color: #2e7d32;
}

.activity-pill.status-blocked {
  background: #fff8e1;
  color: #b8860b;
}

.variation-pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  background: #f3e5f5;
  color: #7b1fa2;
  font-family: 'JetBrains Mono', monospace;
}

.assign-control {
  display: flex;
  gap: 6px;
  align-items: center;
}

.assign-select {
  font-size: 12px;
  padding: 2px 4px;
  border: 1px solid #ccc;
  border-radius: 4px;
}

.assign-button {
  font-size: 11px;
  padding: 2px 8px;
  border: 1px solid #7b1fa2;
  border-radius: 4px;
  background: #f3e5f5;
  color: #7b1fa2;
  cursor: pointer;
}

.assign-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.unassign-button {
  font-size: 11px;
  padding: 2px 8px;
  border: 1px solid #999;
  border-radius: 4px;
  background: #f5f5f5;
  color: #666;
  cursor: pointer;
}

.unassign-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.assign-error {
  margin-top: 4px;
  font-size: 11px;
  color: #c62828;
}
</style>
