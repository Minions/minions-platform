import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import MissionList from './MissionList.vue';
import * as cabinet from '../api/cabinet';
import type { MissionListResult } from '@minions/mcp-types';

vi.mock('../api/cabinet', () => ({
  callMCPConductor: vi.fn(),
}));

describe('MissionList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads missions on mount', async () => {
    const mockMissions = [
      { costume: 'test-costume', name: 'echo', description: 'Echo test', isLegacy: false, runnable: true }
    ];
    vi.spyOn(cabinet, 'callMCPConductor').mockResolvedValue({ missions: mockMissions } as MissionListResult);

    const wrapper = mount(MissionList, {
      props: { wingName: 'test' }
    });

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(cabinet.callMCPConductor).toHaveBeenCalledWith('missions', {
      action: 'list',
      wingName: 'test'
    });
    expect(wrapper.text()).toContain('echo');
  });

  it('shows empty state when no missions', async () => {
    vi.spyOn(cabinet, 'callMCPConductor').mockResolvedValue({ missions: [] } as MissionListResult);

    const wrapper = mount(MissionList, {
      props: { wingName: 'test' }
    });

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('No missions');
  });

  it('displays mission with costume and name', async () => {
    const mockMissions = [
      { costume: 'my-costume', name: 'greet', description: 'Greeting mission', isLegacy: false, runnable: true }
    ];
    vi.spyOn(cabinet, 'callMCPConductor').mockResolvedValue({ missions: mockMissions } as MissionListResult);

    const wrapper = mount(MissionList, {
      props: { wingName: 'test' }
    });

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('greet');
    expect(wrapper.text()).toContain('my-costume');
    expect(wrapper.text()).toContain('Greeting mission');
  });

  it('shows non-deterministic badge for non-deterministic missions', async () => {
    const mockMissions = [
      { costume: 'old-costume', name: 'nd-mission', isLegacy: true, runnable: false }
    ];
    vi.spyOn(cabinet, 'callMCPConductor').mockResolvedValue({ missions: mockMissions } as MissionListResult);

    const wrapper = mount(MissionList, {
      props: { wingName: 'test' }
    });

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('Non-deterministic');
    expect(wrapper.find('.mission-legacy').exists()).toBe(true);
  });

  it('does not show non-deterministic badge for deterministic missions', async () => {
    const mockMissions = [
      { costume: 'new-costume', name: 'ts-mission', isLegacy: false, runnable: true }
    ];
    vi.spyOn(cabinet, 'callMCPConductor').mockResolvedValue({ missions: mockMissions } as MissionListResult);

    const wrapper = mount(MissionList, {
      props: { wingName: 'test' }
    });

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.find('.mission-legacy').exists()).toBe(false);
  });

  it('displays mission arguments', async () => {
    const mockMissions = [
      {
        costume: 'test-costume',
        name: 'echo',
        isLegacy: false,
        runnable: true,
        argsSchema: {
          type: 'object' as const,
          properties: {
            message: { type: 'string' as const, description: 'The message to echo' },
            count: { type: 'number' as const, description: 'How many times' }
          },
          required: ['message']
        }
      }
    ];
    vi.spyOn(cabinet, 'callMCPConductor').mockResolvedValue({ missions: mockMissions } as MissionListResult);

    const wrapper = mount(MissionList, {
      props: { wingName: 'test' }
    });

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('message');
    expect(wrapper.text()).toContain('count');

    // Required args should have the required class
    const argChips = wrapper.findAll('.arg-chip');
    const messageChip = argChips.find(chip => chip.text().includes('message'));
    expect(messageChip?.classes()).toContain('required');
  });

  it('emits select event when mission clicked', async () => {
    const mockMission = { costume: 'test-costume', name: 'echo', isLegacy: false, runnable: true };
    vi.spyOn(cabinet, 'callMCPConductor').mockResolvedValue({ missions: [mockMission] } as MissionListResult);

    const wrapper = mount(MissionList, {
      props: { wingName: 'test' }
    });

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    await wrapper.find('.mission-card').trigger('click');

    const selectEvents = wrapper.emitted('select');
    expect(selectEvents).toBeTruthy();
    expect(selectEvents?.[0]).toEqual([mockMission]);
  });

  it('handles load errors gracefully', async () => {
    vi.spyOn(cabinet, 'callMCPConductor').mockRejectedValue(
      new Error('Failed to load missions')
    );

    const wrapper = mount(MissionList, {
      props: { wingName: 'test' }
    });

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('Failed to load missions');
  });

  it('correctly extracts missions array from API result', async () => {
    const mockMissionsArray = [
      { costume: 'costume-a', name: 'mission-1', isLegacy: false, runnable: true },
      { costume: 'costume-b', name: 'mission-2', isLegacy: true, runnable: false }
    ];

    vi.spyOn(cabinet, 'callMCPConductor').mockResolvedValue({
      missions: mockMissionsArray
    } as MissionListResult);

    const wrapper = mount(MissionList, {
      props: { wingName: 'test' }
    });

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify loading state is cleared
    expect(wrapper.find('.loading').exists()).toBe(false);

    // Verify we can find both mission cards
    const missionCards = wrapper.findAll('.mission-card');
    expect(missionCards.length).toBe(2);

    // Verify each mission renders correctly
    expect(wrapper.text()).toContain('mission-1');
    expect(wrapper.text()).toContain('mission-2');
  });
});
