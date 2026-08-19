import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import MovementView from './MovementView.vue';
import * as cabinet from '../api/cabinet';

vi.mock('../api/cabinet', () => ({
  callMCPThrone: vi.fn(),
  callMCPHenchery: vi.fn(),
  callMCPThroneRaw: vi.fn(),
}));

function mockWings() {
  vi.spyOn(cabinet, 'callMCPThrone').mockResolvedValue({
    lairName: 'TestLair',
    wings: [
      { name: 'workshop-01', extraWork: [{ name: 'billing-service' }] },
      { name: 'workshop-02', extraWork: [] },
    ],
    availableWorkRepos: ['local'],
  } as never);
}

describe('MovementView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWings();
  });

  it('loads wings on mount and defaults to the first one', async () => {
    const wrapper = mount(MovementView);
    await flushPromises();

    expect(cabinet.callMCPThrone).toHaveBeenCalledWith('lair_get_state', {});
    expect(wrapper.find('select').element.value).toBe('workshop-01');
  });

  it('populates repo options from the selected wing\'s local + extraWork', async () => {
    const wrapper = mount(MovementView);
    await flushPromises();

    const repoSelect = wrapper.findAll('select')[1];
    const options = repoSelect.findAll('option').map(o => o.element.value);
    expect(options).toEqual(['local', 'billing-service']);
  });

  it('calls movement status via henchery scoped to the selected wing and repo', async () => {
    vi.spyOn(cabinet, 'callMCPHenchery').mockResolvedValue({
      branch: 'l/minions-nabu/w/workshop-01',
      isMovementBranch: false,
      isDirty: false,
    } as never);

    const wrapper = mount(MovementView);
    await flushPromises();

    await wrapper.find('button.status-btn').trigger('click');
    await flushPromises();

    expect(cabinet.callMCPHenchery).toHaveBeenCalledWith('workshop-01', 'movement', {
      action: 'status',
      repo: 'local',
    });
    expect(wrapper.text()).toContain('l/minions-nabu/w/workshop-01');
  });

  it('re-scopes the status call when a different repo is selected', async () => {
    vi.spyOn(cabinet, 'callMCPHenchery').mockResolvedValue({
      branch: 'main',
      isMovementBranch: false,
      isDirty: false,
    } as never);

    const wrapper = mount(MovementView);
    await flushPromises();

    const repoSelect = wrapper.findAll('select')[1];
    await repoSelect.setValue('billing-service');
    await wrapper.find('button.status-btn').trigger('click');
    await flushPromises();

    expect(cabinet.callMCPHenchery).toHaveBeenCalledWith('workshop-01', 'movement', {
      action: 'status',
      repo: 'billing-service',
    });
  });

  it('shows an error message when the status call fails', async () => {
    vi.spyOn(cabinet, 'callMCPHenchery').mockRejectedValue(new Error('boom'));

    const wrapper = mount(MovementView);
    await flushPromises();

    await wrapper.find('button.status-btn').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('boom');
  });

  it('calls movement diff via throne with the selected wing and repo, and renders the result', async () => {
    vi.spyOn(cabinet, 'callMCPThroneRaw').mockResolvedValue({
      diff: '--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n',
    } as never);

    const wrapper = mount(MovementView);
    await flushPromises();

    await wrapper.find('button.diff-btn').trigger('click');
    await flushPromises();

    expect(cabinet.callMCPThroneRaw).toHaveBeenCalledWith('movement', {
      action: 'diff',
      wing: 'workshop-01',
      repo: 'local',
    });
    expect(wrapper.text()).toContain('-old');
    expect(wrapper.text()).toContain('+new');
  });

  it('re-scopes the diff call when a different repo is selected', async () => {
    vi.spyOn(cabinet, 'callMCPThroneRaw').mockResolvedValue({ diff: '' } as never);

    const wrapper = mount(MovementView);
    await flushPromises();

    const repoSelect = wrapper.findAll('select')[1];
    await repoSelect.setValue('billing-service');
    await wrapper.find('button.diff-btn').trigger('click');
    await flushPromises();

    expect(cabinet.callMCPThroneRaw).toHaveBeenCalledWith('movement', {
      action: 'diff',
      wing: 'workshop-01',
      repo: 'billing-service',
    });
  });

  it('shows an error message when the diff call fails', async () => {
    vi.spyOn(cabinet, 'callMCPThroneRaw').mockRejectedValue(new Error('diff boom'));

    const wrapper = mount(MovementView);
    await flushPromises();

    await wrapper.find('button.diff-btn').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('diff boom');
  });
});
