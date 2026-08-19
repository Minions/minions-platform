import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import MissionEventStream from './MissionEventStream.vue';
import * as cabinet from '../api/cabinet';
import type { MissionRunStatus, MissionEventRecord } from '@minions/mcp-types';

// Mock the cabinet module
vi.mock('../api/cabinet', () => ({
  callMCPThrone: vi.fn(),
  callMCPConductor: vi.fn(),
  missionEvents: {
    subscribe: vi.fn(() => vi.fn()), // Returns unsubscribe function
  },
}));

// Helper to create valid event results
function createEventsResult(
  status: MissionRunStatus,
  events: MissionEventRecord[]
) {
  return { missionRunId: 'run-123', status, events };
}

describe('MissionEventStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const defaultProps = {
    missionRunId: 'run-123',
    missionName: 'test-mission',
    costume: 'test-costume'
  };

  it('displays mission name and costume', async () => {
    vi.mocked(cabinet.callMCPThrone).mockResolvedValue(createEventsResult('running', []));

    const wrapper = mount(MissionEventStream, {
      props: defaultProps
    });

    await flushPromises();

    expect(wrapper.text()).toContain('test-mission');
    expect(wrapper.text()).toContain('test-costume');
  });

  it('shows running status initially', async () => {
    vi.mocked(cabinet.callMCPThrone).mockResolvedValue(createEventsResult('running', []));

    const wrapper = mount(MissionEventStream, {
      props: defaultProps
    });

    await flushPromises();

    expect(wrapper.find('.status-running').exists()).toBe(true);
    expect(wrapper.text()).toContain('Running');
  });

  it('loads initial events on mount', async () => {
    vi.mocked(cabinet.callMCPThrone).mockResolvedValue(createEventsResult('running', []));

    mount(MissionEventStream, {
      props: defaultProps
    });

    await flushPromises();

    expect(cabinet.callMCPThrone).toHaveBeenCalledWith('missions', {
      action: 'events',
      missionRunId: 'run-123'
    });
  });

  it('subscribes to mission events on mount', async () => {
    vi.mocked(cabinet.callMCPThrone).mockResolvedValue(createEventsResult('running', []));

    mount(MissionEventStream, {
      props: defaultProps
    });

    await flushPromises();

    expect(cabinet.missionEvents.subscribe).toHaveBeenCalledWith('run-123', expect.any(Function));
  });

  it('displays events from initial load', async () => {
    vi.mocked(cabinet.callMCPThrone).mockResolvedValue(
      createEventsResult('running', [
        { type: 'started', timestamp: Date.now(), data: {} }
      ])
    );

    const wrapper = mount(MissionEventStream, {
      props: defaultProps
    });

    await flushPromises();

    expect(wrapper.text()).toContain('Started');
  });

  it('updates status when mission completes', async () => {
    vi.mocked(cabinet.callMCPThrone).mockResolvedValue(
      createEventsResult('completed', [
        { type: 'started', timestamp: Date.now(), data: {} },
        { type: 'completed', timestamp: Date.now(), data: { result: 'Success' } }
      ])
    );

    const wrapper = mount(MissionEventStream, {
      props: defaultProps
    });

    await flushPromises();

    expect(wrapper.find('.status-completed').exists()).toBe(true);
    expect(wrapper.text()).toContain('Completed');
  });

  it('shows cancel button when running', async () => {
    vi.mocked(cabinet.callMCPThrone).mockResolvedValue(createEventsResult('running', []));

    const wrapper = mount(MissionEventStream, {
      props: defaultProps
    });

    await flushPromises();

    expect(wrapper.find('.cancel-button').exists()).toBe(true);
  });

  it('cancels mission when cancel button clicked', async () => {
    vi.mocked(cabinet.callMCPThrone)
      .mockResolvedValueOnce(createEventsResult('running', []));
    vi.mocked(cabinet.callMCPConductor)
      .mockResolvedValueOnce({ success: true, missionRunId: 'run-123' });

    const wrapper = mount(MissionEventStream, {
      props: defaultProps
    });

    await flushPromises();

    await wrapper.find('.cancel-button').trigger('click');
    await flushPromises();

    expect(cabinet.callMCPConductor).toHaveBeenCalledWith('missions', {
      action: 'cancel',
      missionRunId: 'run-123',
      reason: 'Cancelled by user'
    });
  });

  it('emits close event when close button clicked', async () => {
    vi.mocked(cabinet.callMCPThrone).mockResolvedValue(createEventsResult('running', []));

    const wrapper = mount(MissionEventStream, {
      props: defaultProps
    });

    await flushPromises();

    await wrapper.find('.close-button').trigger('click');

    expect(wrapper.emitted('close')).toBeTruthy();
  });

  it('displays failed status for failed missions', async () => {
    vi.mocked(cabinet.callMCPThrone).mockResolvedValue(
      createEventsResult('failed', [
        { type: 'failed', timestamp: Date.now(), data: { error: 'Something went wrong' } }
      ])
    );

    const wrapper = mount(MissionEventStream, {
      props: defaultProps
    });

    await flushPromises();

    expect(wrapper.find('.status-failed').exists()).toBe(true);
    expect(wrapper.text()).toContain('Something went wrong');
  });

  it('shows loading message initially', () => {
    vi.mocked(cabinet.callMCPThrone).mockResolvedValue(createEventsResult('running', []));

    const wrapper = mount(MissionEventStream, {
      props: defaultProps
    });

    // Before promise resolves, should show loading
    expect(wrapper.text()).toContain('Loading events');
  });

  it('shows waiting for events when no events yet', async () => {
    vi.mocked(cabinet.callMCPThrone).mockResolvedValue(createEventsResult('running', []));

    const wrapper = mount(MissionEventStream, {
      props: defaultProps
    });

    await flushPromises();

    expect(wrapper.text()).toContain('Waiting for events');
  });

  it('formats different event types correctly', async () => {
    vi.mocked(cabinet.callMCPThrone).mockResolvedValue(
      createEventsResult('running', [
        { type: 'minion_spawned', timestamp: Date.now(), data: { minionId: 'min-1' } },
        { type: 'question_asked', timestamp: Date.now(), data: { question: 'What next?' } }
      ])
    );

    const wrapper = mount(MissionEventStream, {
      props: defaultProps
    });

    await flushPromises();

    expect(wrapper.text()).toContain('min-1');
    expect(wrapper.text()).toContain('What next?');
  });

  it('handles load errors gracefully', async () => {
    vi.mocked(cabinet.callMCPThrone).mockRejectedValue(new Error('Network error'));

    const wrapper = mount(MissionEventStream, {
      props: defaultProps
    });

    await flushPromises();

    expect(wrapper.text()).toContain('Network error');
  });

  it('unsubscribes from events on unmount', async () => {
    const unsubscribeMock = vi.fn();
    vi.mocked(cabinet.missionEvents.subscribe).mockReturnValue(unsubscribeMock);
    vi.mocked(cabinet.callMCPThrone).mockResolvedValue(createEventsResult('running', []));

    const wrapper = mount(MissionEventStream, {
      props: defaultProps
    });

    await flushPromises();

    wrapper.unmount();

    expect(unsubscribeMock).toHaveBeenCalled();
  });
});
