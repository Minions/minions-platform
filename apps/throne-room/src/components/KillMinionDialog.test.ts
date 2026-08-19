import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import KillMinionDialog from './KillMinionDialog.vue';
import * as cabinet from '../api/cabinet';

vi.mock('../api/cabinet', () => ({
  callMCPConductor: vi.fn(),
}));

describe('KillMinionDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders confirmation dialog', () => {
    const wrapper = mount(KillMinionDialog, {
      props: { minionId: 'minion-1' }
    });

    expect(wrapper.text()).toContain('Kill Minion');
    expect(wrapper.text()).toContain('Are you sure');
  });

  it('shows minion ID in confirmation', () => {
    const wrapper = mount(KillMinionDialog, {
      props: { minionId: 'minion-123' }
    });

    expect(wrapper.text()).toContain('minion-123');
  });

  it('emits cancel when cancel clicked', async () => {
    const wrapper = mount(KillMinionDialog, {
      props: { minionId: 'minion-1' }
    });

    await wrapper.find('button').trigger('click'); // First button is cancel

    expect(wrapper.emitted('cancel')).toBeTruthy();
  });

  it('calls minions kill when confirmed', async () => {
    vi.spyOn(cabinet, 'callMCPConductor').mockResolvedValue({
      message: 'Minion killed',
      dumpPath: '/path/to/dump.json'
    });

    const wrapper = mount(KillMinionDialog, {
      props: { minionId: 'minion-1' }
    });

    const buttons = wrapper.findAll('button');
    await buttons[1].trigger('click'); // Second button is confirm

    expect(cabinet.callMCPConductor).toHaveBeenCalledWith('minions', {
      action: 'kill',
      minionId: 'minion-1'
    });
  });

  it('emits killed event with dump path', async () => {
    const dumpPath = '/path/to/minion-test-20250120-143022.json';
    vi.spyOn(cabinet, 'callMCPConductor').mockResolvedValue({
      message: 'Minion killed',
      dumpPath
    });

    const wrapper = mount(KillMinionDialog, {
      props: { minionId: 'minion-1' }
    });

    const buttons = wrapper.findAll('button');
    await buttons[1].trigger('click');
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    const killedEvents = wrapper.emitted('killed');
    expect(killedEvents).toBeTruthy();
    expect(killedEvents?.[0]).toEqual([dumpPath]);
  });

  it('shows error on kill failure', async () => {
    vi.spyOn(cabinet, 'callMCPConductor').mockRejectedValue(
      new Error('Failed to kill')
    );

    const wrapper = mount(KillMinionDialog, {
      props: { minionId: 'minion-1' }
    });

    const buttons = wrapper.findAll('button');
    await buttons[1].trigger('click');
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('Failed to kill');
  });

  it('disables buttons while killing', async () => {
    vi.spyOn(cabinet, 'callMCPConductor').mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve({
        message: 'Minion killed',
        dumpPath: '/path/dump.json'
      }), 100))
    );

    const wrapper = mount(KillMinionDialog, {
      props: { minionId: 'minion-1' }
    });

    const buttons = wrapper.findAll('button');
    await buttons[1].trigger('click');

    buttons.forEach(btn => {
      expect(btn.attributes('disabled')).toBeDefined();
    });
  });
});
