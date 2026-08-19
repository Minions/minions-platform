import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import MissionManagement from './MissionManagement.vue';
import * as cabinet from '../api/cabinet';
import type { MCPToolMap } from '@minions/mcp-types';

vi.mock('../api/cabinet', () => ({
  callMCPThrone: vi.fn(),
  callMCPConductor: vi.fn(),
  cabinetEvents: {
    subscribe: vi.fn(() => vi.fn()),
    emit: vi.fn(),
  },
  missionEvents: {
    subscribe: vi.fn(() => vi.fn()),
    subscribeAll: vi.fn(() => vi.fn()),
  },
  questionEvents: {
    subscribe: vi.fn(() => vi.fn()),
  },
}));

describe('MissionManagement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Default mock for throne tools (ask list, missions events)
    vi.mocked(cabinet.callMCPThrone).mockImplementation(
      async <K extends keyof MCPToolMap>(tool: K): Promise<MCPToolMap[K]['result']> => {
        if (tool === 'ask') {
          return { questions: [] } as unknown as MCPToolMap[K]['result'];
        }
        if (tool === 'missions') {
          return { missionRunId: 'run-123', status: 'running', events: [] } as unknown as MCPToolMap[K]['result'];
        }
        return {} as MCPToolMap[K]['result'];
      }
    );
    // Default mock for conductor tools (missions list/start)
    vi.mocked(cabinet.callMCPConductor).mockImplementation(
      async <K extends keyof MCPToolMap>(tool: K): Promise<MCPToolMap[K]['result']> => {
        if (tool === 'missions') {
          return {
            missions: [
              { costume: 'test-costume', name: 'echo', description: 'Echo test', isLegacy: false }
            ]
          } as unknown as MCPToolMap[K]['result'];
        }
        return {} as MCPToolMap[K]['result'];
      }
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows mission list by default', async () => {
    const wrapper = mount(MissionManagement, {
      props: { wingName: 'test-wing' }
    });

    await vi.advanceTimersByTimeAsync(0);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.mission-list-view').exists()).toBe(true);
  });

  it('transitions to start form when mission selected', async () => {
    const wrapper = mount(MissionManagement, {
      props: { wingName: 'test-wing' }
    });

    await vi.advanceTimersByTimeAsync(0);
    await wrapper.vm.$nextTick();

    // Click on a mission card
    const missionCard = wrapper.find('.mission-card');
    await missionCard.trigger('click');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.mission-start-view').exists()).toBe(true);
    expect(wrapper.text()).toContain('Back to Missions');
  });

  it('goes back to list when back button clicked', async () => {
    const wrapper = mount(MissionManagement, {
      props: { wingName: 'test-wing' }
    });

    await vi.advanceTimersByTimeAsync(0);
    await wrapper.vm.$nextTick();

    // Select a mission
    await wrapper.find('.mission-card').trigger('click');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.mission-start-view').exists()).toBe(true);

    // Click back button
    await wrapper.find('.back-button').trigger('click');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.mission-list-view').exists()).toBe(true);
  });

  it('transitions to stream view when mission started', async () => {
    const wrapper = mount(MissionManagement, {
      props: { wingName: 'test-wing' }
    });

    await vi.advanceTimersByTimeAsync(0);
    await wrapper.vm.$nextTick();

    // Select a mission
    await wrapper.find('.mission-card').trigger('click');
    await wrapper.vm.$nextTick();

    // Submit the start form
    await wrapper.find('form').trigger('submit.prevent');
    await wrapper.vm.$nextTick();
    await vi.advanceTimersByTimeAsync(0);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.mission-stream-view').exists()).toBe(true);
  });

  it('returns to list when stream is closed', async () => {
    const wrapper = mount(MissionManagement, {
      props: { wingName: 'test-wing' }
    });

    await vi.advanceTimersByTimeAsync(0);
    await wrapper.vm.$nextTick();

    // Select and start mission
    await wrapper.find('.mission-card').trigger('click');
    await wrapper.vm.$nextTick();
    await wrapper.find('form').trigger('submit.prevent');
    await wrapper.vm.$nextTick();
    await vi.advanceTimersByTimeAsync(0);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.mission-stream-view').exists()).toBe(true);

    // Close the stream
    await wrapper.find('.close-button').trigger('click');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.mission-list-view').exists()).toBe(true);
  });

  it('shows questions list in stream view', async () => {
    const wrapper = mount(MissionManagement, {
      props: { wingName: 'test-wing' }
    });

    await vi.advanceTimersByTimeAsync(0);
    await wrapper.vm.$nextTick();

    // Select and start mission
    await wrapper.find('.mission-card').trigger('click');
    await wrapper.vm.$nextTick();
    await wrapper.find('form').trigger('submit.prevent');
    await wrapper.vm.$nextTick();
    await vi.advanceTimersByTimeAsync(0);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.mission-questions').exists()).toBe(true);
  });
});
