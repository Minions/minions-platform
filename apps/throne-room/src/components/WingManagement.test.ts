import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import WingManagement from './WingManagement.vue';
import MinionList from './MinionList.vue';
import MinionSpawnForm from './MinionSpawnForm.vue';
import MinionDebugView from './MinionDebugView.vue';
import QuestionsList from './QuestionsList.vue';
import MissionManagement from './MissionManagement.vue';
import * as cabinet from '../api/cabinet';
import type { MCPToolMap, MinionSummary, MinionClient, MinionStatus } from '@minions/mcp-types';

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

// Helper to create properly typed minion data
function createMinion(overrides: Partial<MinionSummary> & { id: string }): MinionSummary {
  return {
    client: 'claude-code' as MinionClient,
    status: 'idle' as MinionStatus,
    wingName: 'test',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('WingManagement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock implementation that handles throne tools
    vi.mocked(cabinet.callMCPThrone).mockImplementation(
      <K extends keyof MCPToolMap>(tool: K, args: MCPToolMap[K]['params']): Promise<MCPToolMap[K]['result']> => {
        if (tool === 'minions') {
          const action = (args as Record<string, unknown>).action;
          if (action === 'list') return Promise.resolve({ minions: [] }) as unknown as Promise<MCPToolMap[K]['result']>;
          if (action === 'get_interactions') return Promise.resolve({ interactions: [] }) as unknown as Promise<MCPToolMap[K]['result']>;
        }
        if (tool === 'ask') return Promise.resolve({ questions: [] }) as unknown as Promise<MCPToolMap[K]['result']>;
        return Promise.resolve({}) as unknown as Promise<MCPToolMap[K]['result']>;
      }
    );
    // Default mock for conductor tools
    vi.mocked(cabinet.callMCPConductor).mockImplementation(
      <K extends keyof MCPToolMap>(tool: K): Promise<MCPToolMap[K]['result']> => {
        if (tool === 'missions') return Promise.resolve({ missions: [] }) as unknown as Promise<MCPToolMap[K]['result']>;
        return Promise.resolve({}) as unknown as Promise<MCPToolMap[K]['result']>;
      }
    );
  });

  it('renders wing name and info', () => {
    const wrapper = mount(WingManagement, {
      props: {
        wing: {
          name: 'test-wing',
          root: '/path/to/wing',
          workLocal: '/path/work/local',
          privateLocal: '/path/private/local'
        }
      }
    });

    expect(wrapper.text()).toContain('test-wing');
    expect(wrapper.text()).toContain('/path/to/wing');
  });

  it('shows tabbed navigation for wing sections', () => {
    const wrapper = mount(WingManagement, {
      props: {
        wing: {
          name: 'test-wing',
          root: '/path',
          workLocal: '/work',
          privateLocal: '/private'
        }
      }
    });

    expect(wrapper.text()).toContain('Overview');
    expect(wrapper.text()).toContain('Minions');
    expect(wrapper.text()).toContain('Missions');
    expect(wrapper.text()).toContain('Questions');
  });

  it('shows wing overview by default', () => {
    const wrapper = mount(WingManagement, {
      props: {
        wing: {
          name: 'test',
          root: '/path',
          workLocal: '/work',
          privateLocal: '/private'
        }
      }
    });

    expect(wrapper.html()).toContain('Work Directories');
    expect(wrapper.html()).toContain('Private Directories');
  });

  it('switches to minions tab when clicked', async () => {
    vi.spyOn(cabinet, 'callMCPThrone').mockResolvedValue({ minions: [] } as never);

    const wrapper = mount(WingManagement, {
      props: {
        wing: {
          name: 'test',
          root: '/path',
          workLocal: '/work',
          privateLocal: '/private'
        }
      }
    });

    const minionsTab = wrapper.findAll('.tab-button')[1];
    await minionsTab.trigger('click');
    await wrapper.vm.$nextTick();

    // Should show spawn button and minion list
    expect(wrapper.html()).toContain('Spawn Minion');
    expect(wrapper.findComponent(MinionList).exists()).toBe(true);
  });

  it('switches to questions tab when clicked', async () => {
    vi.spyOn(cabinet, 'callMCPThrone').mockResolvedValue({ questions: [] } as never);

    const wrapper = mount(WingManagement, {
      props: {
        wing: {
          name: 'test',
          root: '/path',
          workLocal: '/work',
          privateLocal: '/private'
        }
      }
    });

    // Questions is now at index 3 (after Overview, Minions, Missions)
    const questionsTab = wrapper.findAll('.tab-button')[3];
    await questionsTab.trigger('click');
    await wrapper.vm.$nextTick();

    expect(wrapper.findComponent(QuestionsList).exists()).toBe(true);
  });

  it('switches to missions tab when clicked', async () => {
    const wrapper = mount(WingManagement, {
      props: {
        wing: {
          name: 'test',
          root: '/path',
          workLocal: '/work',
          privateLocal: '/private'
        }
      }
    });

    // Missions is at index 2 (after Overview, Minions)
    const missionsTab = wrapper.findAll('.tab-button')[2];
    await missionsTab.trigger('click');
    await wrapper.vm.$nextTick();

    expect(wrapper.findComponent(MissionManagement).exists()).toBe(true);
  });

  it('shows spawn form when spawn button clicked', async () => {
    vi.spyOn(cabinet, 'callMCPThrone').mockResolvedValue({ minions: [] } as never);

    const wrapper = mount(WingManagement, {
      props: {
        wing: {
          name: 'test',
          root: '/path',
          workLocal: '/work',
          privateLocal: '/private'
        }
      }
    });

    // Switch to minions tab
    const minionsTab = wrapper.findAll('.tab-button')[1];
    await minionsTab.trigger('click');
    await wrapper.vm.$nextTick();

    // Click spawn button
    const spawnBtn = wrapper.find('button.spawn-btn');
    await spawnBtn.trigger('click');
    await wrapper.vm.$nextTick();

    expect(wrapper.findComponent(MinionSpawnForm).exists()).toBe(true);
  });

  it('hides spawn form after spawning minion', async () => {
    vi.spyOn(cabinet, 'callMCPThrone').mockResolvedValue({ minions: [] } as never);

    const wrapper = mount(WingManagement, {
      props: {
        wing: {
          name: 'test',
          root: '/path',
          workLocal: '/work',
          privateLocal: '/private'
        }
      }
    });

    // Switch to minions tab and show form
    const minionsTab = wrapper.findAll('.tab-button')[1];
    await minionsTab.trigger('click');
    const spawnBtn = wrapper.find('button.spawn-btn');
    await spawnBtn.trigger('click');
    await wrapper.vm.$nextTick();

    // Emit created event from spawn form
    const spawnForm = wrapper.findComponent(MinionSpawnForm);
    await spawnForm.vm.$emit('created', { id: 'minion-1' });
    await wrapper.vm.$nextTick();

    expect(wrapper.findComponent(MinionSpawnForm).exists()).toBe(false);
  });

  it('shows debug view when minion selected', async () => {
    const mockMinions = [createMinion({ id: 'minion-1' })];
    vi.mocked(cabinet.callMCPThrone).mockImplementation(
      <K extends keyof MCPToolMap>(tool: K, args: MCPToolMap[K]['params']): Promise<MCPToolMap[K]['result']> => {
        if (tool === 'minions') {
          const action = (args as Record<string, unknown>).action;
          if (action === 'list') return Promise.resolve({ minions: mockMinions }) as unknown as Promise<MCPToolMap[K]['result']>;
          if (action === 'get_interactions') return Promise.resolve({ interactions: [] }) as unknown as Promise<MCPToolMap[K]['result']>;
        }
        if (tool === 'ask') return Promise.resolve({ questions: [] }) as unknown as Promise<MCPToolMap[K]['result']>;
        return Promise.resolve({}) as unknown as Promise<MCPToolMap[K]['result']>;
      }
    );

    const wrapper = mount(WingManagement, {
      props: {
        wing: {
          name: 'test',
          root: '/path',
          workLocal: '/work',
          privateLocal: '/private'
        }
      }
    });

    // Switch to minions tab
    const minionsTab = wrapper.findAll('.tab-button')[1];
    await minionsTab.trigger('click');
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    // Select minion from list
    const minionList = wrapper.findComponent(MinionList);
    await minionList.vm.$emit('select', 'minion-1');
    await wrapper.vm.$nextTick();

    expect(wrapper.findComponent(MinionDebugView).exists()).toBe(true);
  });

  it('returns to minion list when minion killed', async () => {
    const mockMinions = [createMinion({ id: 'minion-1' })];
    vi.mocked(cabinet.callMCPThrone).mockImplementation(
      <K extends keyof MCPToolMap>(tool: K, args: MCPToolMap[K]['params']): Promise<MCPToolMap[K]['result']> => {
        if (tool === 'minions') {
          const action = (args as Record<string, unknown>).action;
          if (action === 'list') return Promise.resolve({ minions: mockMinions }) as unknown as Promise<MCPToolMap[K]['result']>;
          if (action === 'get_interactions') return Promise.resolve({ interactions: [] }) as unknown as Promise<MCPToolMap[K]['result']>;
        }
        return Promise.resolve({}) as unknown as Promise<MCPToolMap[K]['result']>;
      }
    );

    const wrapper = mount(WingManagement, {
      props: {
        wing: {
          name: 'test',
          root: '/path',
          workLocal: '/work',
          privateLocal: '/private'
        }
      }
    });

    // Navigate to debug view
    const minionsTab = wrapper.findAll('.tab-button')[1];
    await minionsTab.trigger('click');
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    const minionList = wrapper.findComponent(MinionList);
    await minionList.vm.$emit('select', 'minion-1');
    await wrapper.vm.$nextTick();

    // Kill minion
    const debugView = wrapper.findComponent(MinionDebugView);
    await debugView.vm.$emit('killed', 'minion-1', '/path/to/dump.json');
    await wrapper.vm.$nextTick();

    // Should return to list
    expect(wrapper.findComponent(MinionDebugView).exists()).toBe(false);
    expect(wrapper.findComponent(MinionList).exists()).toBe(true);
  });

  it('refreshes minion list after spawning', async () => {
    const loadSpy = vi.spyOn(cabinet, 'callMCPThrone')
      .mockResolvedValue({ minions: [] } as never);

    const wrapper = mount(WingManagement, {
      props: {
        wing: {
          name: 'test',
          root: '/path',
          workLocal: '/work',
          privateLocal: '/private'
        }
      }
    });

    // Navigate to minions, show form, create minion
    const minionsTab = wrapper.findAll('.tab-button')[1];
    await minionsTab.trigger('click');
    await wrapper.vm.$nextTick();
    loadSpy.mockClear();

    const spawnBtn = wrapper.find('button.spawn-btn');
    await spawnBtn.trigger('click');
    const spawnForm = wrapper.findComponent(MinionSpawnForm);
    await spawnForm.vm.$emit('created', { id: 'minion-1' });
    await wrapper.vm.$nextTick();

    // List should reload
    expect(loadSpy).toHaveBeenCalledWith('minions', {
      action: 'list',
      wingName: 'test'
    });
  });
});
