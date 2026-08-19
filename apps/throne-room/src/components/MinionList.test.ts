import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import MinionList from './MinionList.vue';
import * as cabinet from '../api/cabinet';
import type { MinionSummary, MinionClient, MinionStatus } from '@minions/mcp-types';

vi.mock('../api/cabinet', () => ({
  callMCPThrone: vi.fn(),
  cabinetEvents: {
    subscribe: vi.fn(() => vi.fn()),
    emit: vi.fn(),
  },
}));

// Helper to create valid MinionSummary objects
function createMinion(overrides: Partial<MinionSummary> & { id: string }): MinionSummary {
  return {
    client: 'claude-code' as MinionClient,
    status: 'idle' as MinionStatus,
    wingName: 'test',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('MinionList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads minions on mount', async () => {
    const mockMinions = [createMinion({ id: 'minion-1' })];
    vi.spyOn(cabinet, 'callMCPThrone').mockResolvedValue({ minions: mockMinions });

    const wrapper = mount(MinionList, {
      props: { wingName: 'test' }
    });

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(cabinet.callMCPThrone).toHaveBeenCalledWith('minions', {
      action: 'list',
      wingName: 'test'
    });
    expect(wrapper.text()).toContain('minion-1');
  });

  it('shows empty state when no minions', async () => {
    vi.spyOn(cabinet, 'callMCPThrone').mockResolvedValue({ minions: [] });

    const wrapper = mount(MinionList, {
      props: { wingName: 'test' }
    });

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('No minions');
  });

  it('displays minion status with appropriate styling', async () => {
    const mockMinions = [createMinion({ id: 'minion-1', status: 'working' as MinionStatus })];
    vi.spyOn(cabinet, 'callMCPThrone').mockResolvedValue({ minions: mockMinions });

    const wrapper = mount(MinionList, {
      props: { wingName: 'test' }
    });

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    const statusEl = wrapper.find('.minion-status');
    expect(statusEl.text()).toContain('Working');
    expect(statusEl.classes()).toContain('status-working');
  });

  it('shows minion client badge with display name', async () => {
    const mockMinions = [
      createMinion({ id: 'minion-1', client: 'claude-code' as MinionClient }),
      createMinion({ id: 'minion-2', client: 'anthropic-agentic' as MinionClient })
    ];
    vi.spyOn(cabinet, 'callMCPThrone').mockResolvedValue({ minions: mockMinions });

    const wrapper = mount(MinionList, {
      props: { wingName: 'test' }
    });

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    // formatClient looks up the displayName from AVAILABLE_MINION_CLIENTS
    expect(wrapper.text()).toContain('Claude Code');
    expect(wrapper.text()).toContain('Anthropic Agentic');
  });

  it('emits select event when minion clicked', async () => {
    const mockMinions = [createMinion({ id: 'minion-1' })];
    vi.spyOn(cabinet, 'callMCPThrone').mockResolvedValue({ minions: mockMinions });

    const wrapper = mount(MinionList, {
      props: { wingName: 'test' }
    });

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    await wrapper.find('.minion-card').trigger('click');

    const selectEvents = wrapper.emitted('select');
    expect(selectEvents).toBeTruthy();
    expect(selectEvents?.[0]).toEqual(['minion-1']);
  });

  it('refreshes list when reload called', async () => {
    const mockMinions1 = [createMinion({ id: 'minion-1' })];
    const mockMinions2 = [createMinion({ id: 'minion-1', status: 'working' as MinionStatus })];

    const mcpSpy = vi.spyOn(cabinet, 'callMCPThrone')
      .mockResolvedValueOnce({ minions: mockMinions1 })
      .mockResolvedValueOnce({ minions: mockMinions2 });

    const wrapper = mount(MinionList, {
      props: { wingName: 'test' }
    });

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    // Reload
    await (wrapper.vm as unknown as { loadMinions: () => Promise<void> }).loadMinions();
    await wrapper.vm.$nextTick();

    expect(mcpSpy).toHaveBeenCalledTimes(2);
  });

  it('handles load errors gracefully', async () => {
    vi.spyOn(cabinet, 'callMCPThrone').mockRejectedValue(
      new Error('Failed to load')
    );

    const wrapper = mount(MinionList, {
      props: { wingName: 'test' }
    });

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('Failed to load');
  });

  /**
   * CRITICAL REGRESSION TEST
   * This test explicitly guards against the bug where minions.value was assigned
   * the entire result object { minions: [...] } instead of just the array [...].
   *
   * Bug symptoms:
   * - Loading spinner never goes away
   * - Minion list doesn't render
   * - Template iteration fails
   */
  it('correctly extracts minions array from API result wrapper object', async () => {
    const mockMinionsArray = [
      createMinion({ id: 'minion-1' }),
      createMinion({ id: 'minion-2', client: 'opencode' as MinionClient, status: 'working' as MinionStatus })
    ];

    // API returns { minions: [...] } not just [...]
    vi.spyOn(cabinet, 'callMCPThrone').mockResolvedValue({
      minions: mockMinionsArray
    });

    const wrapper = mount(MinionList, {
      props: { wingName: 'test' }
    });

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify loading state is cleared
    expect(wrapper.find('.loading').exists()).toBe(false);

    // Verify we can find both minion cards (proves array was extracted correctly)
    const minionCards = wrapper.findAll('.minion-card');
    expect(minionCards.length).toBe(2);

    // Verify each minion renders correctly (proves iteration over array works)
    expect(wrapper.text()).toContain('minion-1');
    expect(wrapper.text()).toContain('minion-2');

    // Verify minion IDs are accessible (proves template can access minion properties)
    const firstCard = minionCards[0];
    expect(firstCard.find('.minion-id').text()).toBe('minion-1');
  });

  /**
   * INTEGRATION REGRESSION TEST
   * Tests the complete flow from spawning a minion to seeing it in the list.
   * Guards against the bug where spawning a minion returns to a perpetually loading list.
   */
  it('shows newly spawned minion in list after spawn form completes', async () => {
    // Initially empty list
    const initialResult = { minions: [] as MinionSummary[] };

    // After spawn, list has one minion
    const afterSpawnResult = {
      minions: [createMinion({ id: 'new-minion' })]
    };

    vi.spyOn(cabinet, 'callMCPThrone')
      .mockResolvedValueOnce(initialResult)      // Initial load
      .mockResolvedValueOnce(afterSpawnResult);  // After spawn

    const wrapper = mount(MinionList, {
      props: { wingName: 'test' }
    });

    // Wait for initial load
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify empty state
    expect(wrapper.text()).toContain('No minions');

    // Simulate minion spawn by calling loadMinions again (as WingManagement does)
    await (wrapper.vm as unknown as { loadMinions: () => Promise<void> }).loadMinions();
    await wrapper.vm.$nextTick();

    // Verify new minion appears and loading is cleared
    expect(wrapper.find('.loading').exists()).toBe(false);
    expect(wrapper.text()).toContain('new-minion');
    expect(wrapper.findAll('.minion-card').length).toBe(1);
  });
});
