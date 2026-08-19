import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import QualityPanel from './QualityPanel.vue';
import type { QualityStreamPayload } from '../types/quality';

const mockPayload = ref<QualityStreamPayload>({ disabled: false, wings: {} });
const mockConnected = ref(false);

vi.mock('../composables/useQualityStream', () => ({
  useQualityStream: () => ({ payload: mockPayload, connected: mockConnected }),
}));

const timestamp = '2026-01-01T00:00:00.000Z';
const pass = { state: 'pass' as const, timestamp };

function statusWith(overrides: Record<string, unknown> = {}) {
  return { tests: pass, types: pass, build: pass, oxlint: pass, customLint: pass, aggregatedAt: timestamp, isPartial: false, ...overrides };
}

describe('QualityPanel', () => {
  it('shows the disabled note when quality watching is off', () => {
    mockPayload.value = { disabled: true, wings: {} };
    const wrapper = mount(QualityPanel);
    expect(wrapper.text()).toContain('Quality watching is currently disabled');
  });

  it('shows an empty note when no wings are watched', () => {
    mockPayload.value = { disabled: false, wings: {} };
    const wrapper = mount(QualityPanel);
    expect(wrapper.text()).toContain('No wings are currently being watched');
  });

  it('renders a row per wing with a pill per signal', () => {
    mockPayload.value = { disabled: false, wings: { 'wing-a': statusWith(), 'wing-b': statusWith() } };
    const wrapper = mount(QualityPanel);

    expect(wrapper.text()).toContain('wing-a');
    expect(wrapper.text()).toContain('wing-b');
    expect(wrapper.findAll('.signal-pill')).toHaveLength(10); // 2 wings x 5 signals
  });

  it('shows the overall PASS badge when every wing and signal passes', () => {
    mockPayload.value = { disabled: false, wings: { 'wing-a': statusWith() } };
    const wrapper = mount(QualityPanel);
    expect(wrapper.find('.overall-badge').text()).toBe('PASS');
  });

  it('shows the overall FAIL badge when any signal in any wing fails', () => {
    mockPayload.value = {
      disabled: false,
      wings: { 'wing-a': statusWith({ tests: { state: 'fail', timestamp, failures: ['boom'] } }) },
    };
    const wrapper = mount(QualityPanel);
    expect(wrapper.find('.overall-badge').text()).toBe('FAIL');
  });

  it('expands failure details on click, showing first 5 plus a remaining count', async () => {
    const failures = Array.from({ length: 7 }, (_, i) => `failure ${i}`);
    mockPayload.value = {
      disabled: false,
      wings: { 'wing-a': statusWith({ tests: { state: 'fail', timestamp, failures } }) },
    };
    const wrapper = mount(QualityPanel);

    const failPill = wrapper.findAll('.signal-pill').find((p) => p.classes().includes('status-fail'));
    expect(failPill).toBeDefined();
    await failPill?.trigger('click');

    const items = wrapper.findAll('.failure-detail li');
    expect(items).toHaveLength(5);
    expect(wrapper.text()).toContain('+2 more');
  });

  it('does not let a passing pill be clicked open (no failures to show)', () => {
    mockPayload.value = { disabled: false, wings: { 'wing-a': statusWith() } };
    const wrapper = mount(QualityPanel);
    const pill = wrapper.find('.signal-pill');
    expect(pill.attributes('disabled')).toBeDefined();
  });

  it('shows a connected indicator once the stream reports open', () => {
    mockPayload.value = { disabled: false, wings: {} };
    mockConnected.value = true;
    const wrapper = mount(QualityPanel);
    expect(wrapper.find('.connection-dot').classes()).toContain('connected');
  });

  it('shows a fire banner for a recent Tier 3 emergency respawn', () => {
    mockPayload.value = {
      disabled: false,
      wings: {},
      emergency: { reason: 'crash', at: new Date(Date.now() - 30_000).toISOString() },
    };
    const wrapper = mount(QualityPanel);
    expect(wrapper.find('.emergency-banner').exists()).toBe(true);
    expect(wrapper.text()).toContain('reason: crash');
  });

  it('does not show the fire banner once the emergency has aged out of the window', () => {
    mockPayload.value = {
      disabled: false,
      wings: {},
      emergency: { reason: 'crash', at: new Date(Date.now() - 20 * 60_000).toISOString() },
    };
    const wrapper = mount(QualityPanel);
    expect(wrapper.find('.emergency-banner').exists()).toBe(false);
  });

  it('shows no fire banner when no emergency has occurred', () => {
    mockPayload.value = { disabled: false, wings: {} };
    const wrapper = mount(QualityPanel);
    expect(wrapper.find('.emergency-banner').exists()).toBe(false);
  });
});
