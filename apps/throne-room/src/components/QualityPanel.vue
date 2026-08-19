<template>
  <div class="quality-panel">
    <div class="panel-header">
      <span class="connection-dot" :class="{ connected }" :title="connected ? 'Live' : 'Reconnecting…'"></span>
      <span v-if="!disabled" class="overall-badge" :class="`status-${panelOverall}`">{{ panelOverallLabel }}</span>
    </div>

    <p v-if="recentEmergency" class="emergency-banner">
      🔥 Quality checking was on fire at {{ recentEmergency.atLocal }} (reason: {{ recentEmergency.reason }}) —
      the quality-watcher-process failed and was auto-respawned. Watch for it happening again.
    </p>

    <p v-if="disabled" class="disabled-note">
      Quality watching is currently disabled (HACK_OFF_QUALITY_CHECKS). No live signal is available.
    </p>
    <p v-else-if="wingNames.length === 0" class="dim empty-note">
      No wings are currently being watched — open a wing session to start live quality checks.
    </p>

    <table v-else class="quality-table">
      <thead>
        <tr>
          <th>Wing</th>
          <th v-for="signal in SIGNAL_TYPES" :key="signal">{{ SIGNAL_LABELS[signal] }}</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="wingName in wingNames" :key="wingName">
          <tr>
            <td class="wing-name">{{ wingName }}</td>
            <td v-for="signal in SIGNAL_TYPES" :key="signal">
              <button
                type="button"
                class="signal-pill"
                :class="`status-${wings[wingName][signal].state}`"
                :disabled="!hasFailures(wings[wingName][signal])"
                @click="toggleExpanded(wingName, signal)"
              >
                {{ wings[wingName][signal].state }}
                <span v-if="wings[wingName][signal].state === 'running'" class="spinner"></span>
              </button>
            </td>
          </tr>
          <tr v-if="isExpanded(wingName)" class="failures-row">
            <td :colspan="SIGNAL_TYPES.length + 1">
              <div v-for="signal in expandedSignalsFor(wingName)" :key="signal" class="failure-detail">
                <strong>{{ SIGNAL_LABELS[signal] }}:</strong>
                <ul>
                  <li v-for="(failure, i) in firstFailures(wings[wingName][signal])" :key="i">{{ failure }}</li>
                </ul>
                <span v-if="remainingFailureCount(wings[wingName][signal]) > 0" class="dim">
                  +{{ remainingFailureCount(wings[wingName][signal]) }} more
                </span>
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'QualityPanel' });

import { computed, reactive } from 'vue';
import { useQualityStream } from '../composables/useQualityStream';
import { SIGNAL_TYPES, SIGNAL_LABELS, overallState, worstState, type SignalType, type WireSignalState } from '../types/quality';

const FAILURES_SHOWN = 5;

const { payload, connected } = useQualityStream();
const disabled = computed(() => payload.value.disabled);
const wings = computed(() => payload.value.wings);
const wingNames = computed(() => Object.keys(wings.value).sort());

const panelOverall = computed(() => worstState(wingNames.value.map((name) => overallState(wings.value[name]))));
const panelOverallLabel = computed(() => panelOverall.value.toUpperCase());

/** How long after a Tier 3 emergency to keep showing the banner — matches the spirit of cabinet's own `quality_status` note window, not required to match it exactly. */
const EMERGENCY_BANNER_WINDOW_MS = 10 * 60_000;

const recentEmergency = computed(() => {
  const emergency = payload.value.emergency;
  if (!emergency) return undefined;
  const at = new Date(emergency.at);
  if (Date.now() - at.getTime() > EMERGENCY_BANNER_WINDOW_MS) return undefined;
  return { reason: emergency.reason, atLocal: at.toLocaleTimeString() };
});

// Which wings currently have their failure details expanded, and which
// signal within that wing was last clicked to open them.
const expandedWing = reactive<Record<string, SignalType | undefined>>({});

function isExpanded(wingName: string): boolean {
  return expandedWing[wingName] !== undefined;
}

function expandedSignalsFor(wingName: string): SignalType[] {
  const signal = expandedWing[wingName];
  return signal ? [signal] : [];
}

function toggleExpanded(wingName: string, signal: SignalType) {
  expandedWing[wingName] = expandedWing[wingName] === signal ? undefined : signal;
}

function hasFailures(signalState: WireSignalState): boolean {
  return (signalState.state === 'fail' || signalState.state === 'running') && signalState.failures.length > 0;
}

function firstFailures(signalState: WireSignalState): string[] {
  return hasFailures(signalState) && (signalState.state === 'fail' || signalState.state === 'running')
    ? signalState.failures.slice(0, FAILURES_SHOWN)
    : [];
}

function remainingFailureCount(signalState: WireSignalState): number {
  if (!hasFailures(signalState) || (signalState.state !== 'fail' && signalState.state !== 'running')) return 0;
  return Math.max(0, signalState.failures.length - FAILURES_SHOWN);
}
</script>

<style scoped>
.quality-panel {
  padding: 4px;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.connection-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ccc;
}

.connection-dot.connected {
  background: #2e7d32;
}

.overall-badge {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
}

.disabled-note,
.empty-note {
  color: #999;
}

.emergency-banner {
  margin: 0 0 12px;
  padding: 8px 12px;
  border-radius: 6px;
  background: #ffebee;
  color: #c62828;
  font-size: 13px;
  font-weight: 600;
}

.quality-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.quality-table th {
  text-align: left;
  padding: 8px 12px;
  border-bottom: 2px solid #ddd;
  color: #666;
  font-weight: 600;
  font-size: 11px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.quality-table td {
  padding: 6px 12px;
  border-bottom: 1px solid #eee;
  vertical-align: middle;
}

.wing-name {
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
}

.signal-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  border: none;
  cursor: default;
  background: #eee;
  color: #666;
}

.signal-pill:not(:disabled) {
  cursor: pointer;
}

.status-pass,
.overall-badge.status-pass {
  background: #e8f5e9;
  color: #2e7d32;
}

.status-fail,
.overall-badge.status-fail {
  background: #ffebee;
  color: #c62828;
}

.status-running,
.overall-badge.status-running {
  background: #eceff1;
  color: #546e7a;
}

.status-pending,
.overall-badge.status-pending {
  background: #f5f5f5;
  color: #999;
}

.status-stale,
.overall-badge.status-stale {
  background: #fff3e0;
  color: #e65100;
}

.spinner {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.failures-row td {
  background: #fafafa;
}

.failure-detail ul {
  margin: 4px 0;
  padding-left: 18px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  white-space: pre-wrap;
}

.dim {
  color: #999;
}
</style>
