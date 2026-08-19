import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import MinionSpawnForm from './MinionSpawnForm.vue';
import * as cabinet from '../api/cabinet';
import { AVAILABLE_MINION_CLIENTS, type MinionClient, type MinionStatus } from '@minions/mcp-types';

vi.mock('../api/cabinet', () => ({
  callMCPConductor: vi.fn(),
}));

// Helper to create valid spawn result
function createSpawnResult(overrides: { minionId: string; client?: MinionClient; status?: MinionStatus }) {
  return {
    minionId: overrides.minionId,
    client: overrides.client ?? ('claude-code' as MinionClient),
    status: overrides.status ?? ('idle' as MinionStatus),
  };
}

describe('MinionSpawnForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders spawn form', () => {
    const wrapper = mount(MinionSpawnForm, {
      props: { wingName: 'test-wing' }
    });

    expect(wrapper.text()).toContain('Spawn Minion');
    expect(wrapper.find('select').exists()).toBe(true);
  });

  it('shows all available minion client options', () => {
    const wrapper = mount(MinionSpawnForm, {
      props: { wingName: 'test-wing' }
    });

    const options = wrapper.findAll('option');
    expect(options).toHaveLength(AVAILABLE_MINION_CLIENTS.length);

    // Verify each client type is represented
    AVAILABLE_MINION_CLIENTS.forEach((client, index) => {
      expect(options[index].text()).toContain(client.displayName);
    });
  });

  it('shows agent prompt field', () => {
    const wrapper = mount(MinionSpawnForm, {
      props: { wingName: 'test-wing' }
    });

    expect(wrapper.find('textarea').exists()).toBe(true);
    expect(wrapper.text()).toContain('Agent Prompt');
  });

  it('calls minions spawn with client parameter on submit', async () => {
    vi.spyOn(cabinet, 'callMCPConductor').mockResolvedValue(createSpawnResult({ minionId: 'minion-1' }));

    const wrapper = mount(MinionSpawnForm, {
      props: { wingName: 'test-wing' }
    });

    await wrapper.find('select').setValue('claude-code');
    await wrapper.find('form').trigger('submit.prevent');

    expect(cabinet.callMCPConductor).toHaveBeenCalledWith('minions', {
      action: 'spawn',
      wingName: 'test-wing',
      client: 'claude-code'
    });
  });

  it('includes agentPrompt when provided', async () => {
    vi.spyOn(cabinet, 'callMCPConductor').mockResolvedValue(
      createSpawnResult({ minionId: 'minion-1', client: 'anthropic-agentic' as MinionClient })
    );

    const wrapper = mount(MinionSpawnForm, {
      props: { wingName: 'test-wing' }
    });

    await wrapper.find('select').setValue('anthropic-agentic');
    await wrapper.vm.$nextTick();
    await wrapper.find('textarea').setValue('Custom agent prompt');
    await wrapper.find('form').trigger('submit.prevent');

    expect(cabinet.callMCPConductor).toHaveBeenCalledWith('minions', {
      action: 'spawn',
      wingName: 'test-wing',
      client: 'anthropic-agentic',
      agentPrompt: 'Custom agent prompt'
    });
  });

  it('emits created event with minion data', async () => {
    const minionData = createSpawnResult({ minionId: 'minion-1' });
    vi.spyOn(cabinet, 'callMCPConductor').mockResolvedValue(minionData);

    const wrapper = mount(MinionSpawnForm, {
      props: { wingName: 'test-wing' }
    });

    await wrapper.find('form').trigger('submit.prevent');
    await wrapper.vm.$nextTick();

    const createdEvents = wrapper.emitted('created');
    expect(createdEvents).toBeTruthy();
    expect(createdEvents?.[0]).toEqual([minionData]);
  });

  it('handles spawn errors gracefully', async () => {
    vi.spyOn(cabinet, 'callMCPConductor').mockRejectedValue(
      new Error('Failed to spawn')
    );

    const wrapper = mount(MinionSpawnForm, {
      props: { wingName: 'test-wing' }
    });

    await wrapper.find('form').trigger('submit.prevent');
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('Failed to spawn');
  });

  it('disables submit button while spawning', async () => {
    vi.spyOn(cabinet, 'callMCPConductor').mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve({
        minionId: 'minion-1',
        client: 'claude-code',
        status: 'idle'
      }), 100))
    );

    const wrapper = mount(MinionSpawnForm, {
      props: { wingName: 'test-wing' }
    });

    const submitBtn = wrapper.find('button[type="submit"]');
    await wrapper.find('form').trigger('submit.prevent');

    expect(submitBtn.attributes('disabled')).toBeDefined();
  });

  it('shows description for selected client type', async () => {
    const wrapper = mount(MinionSpawnForm, {
      props: { wingName: 'test-wing' }
    });

    // Default is claude-code
    const claudeCodeMeta = AVAILABLE_MINION_CLIENTS.find(c => c.type === 'claude-code');
    expect(claudeCodeMeta).toBeDefined();
    expect(wrapper.text()).toContain(claudeCodeMeta?.description);
  });
});
