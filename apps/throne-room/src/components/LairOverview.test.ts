import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import LairOverview from './LairOverview.vue';
import * as cabinet from '../api/cabinet';
import type { MCPToolMap } from '@minions/mcp-types';

vi.mock('../composables/useQualityStream', () => ({
  useQualityStream: () => ({ payload: { value: { disabled: false, wings: {} } }, connected: { value: false } }),
}));

vi.mock('../api/cabinet', () => ({
  callMCPThrone: vi.fn(),
  // Switchyard (the default tab — see below) calls these on mount; a lair
  // with no work repos and no minions keeps it inert for every test here
  // that isn't specifically exercising it.
  callMCPThroneRaw: vi.fn().mockResolvedValue({ minions: [] }),
  getWorkRepoNames: vi.fn().mockResolvedValue([]),
  cabinetEvents: {
    subscribe: vi.fn(() => vi.fn()),
    emit: vi.fn(),
  },
  questionEvents: {
    subscribe: vi.fn(() => vi.fn()),
  },
}));

// Helper to create a mock that handles common tool calls
function createToolMock(lairState: Record<string, unknown>) {
  return vi.spyOn(cabinet, 'callMCPThrone').mockImplementation(
    <K extends keyof MCPToolMap>(tool: K): Promise<MCPToolMap[K]['result']> => {
      if (tool === 'ask') return Promise.resolve({ questions: [] }) as unknown as Promise<MCPToolMap[K]['result']>;
      if (tool === 'minions') return Promise.resolve({ minions: [] }) as unknown as Promise<MCPToolMap[K]['result']>;
      if (tool === 'lair_get_state') return Promise.resolve(lairState) as unknown as Promise<MCPToolMap[K]['result']>;
      return Promise.resolve(lairState) as unknown as Promise<MCPToolMap[K]['result']>;
    }
  );
}

// Switchyard is now the default tab (it's the primary place to interact with
// wings — see LairOverview.vue), so most of these tests need to switch to
// the Wings tab explicitly before asserting on wings-tab content.
async function openWingsTab(wrapper: ReturnType<typeof mount>) {
  const buttons = wrapper.findAll('button');
  const wingsTab = buttons.find(b => b.text() === 'Wings');
  expect(wingsTab).toBeDefined();
  await wingsTab?.trigger('click');
}

describe('LairOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads wings on mount', async () => {
    const mockWings = [
      { name: 'central-planning', root: '/wings/central-planning' }
    ];

    const mockState = {
      lairName: 'TestCity',
      wings: mockWings,
      availableWorkRepos: ['suite']
    };

    createToolMock(mockState);

    const wrapper = mount(LairOverview);

    // Wait for async load
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));
    await openWingsTab(wrapper);

    expect(cabinet.callMCPThrone).toHaveBeenCalledWith('lair_get_state', {});
    expect(wrapper.text()).toContain('central-planning');
  });

  it('shows loading state', async () => {
    vi.spyOn(cabinet, 'callMCPThrone').mockImplementation(
      <K extends keyof MCPToolMap>(tool: K): Promise<MCPToolMap[K]['result']> => {
        if (tool === 'ask') return Promise.resolve({ questions: [] }) as unknown as Promise<MCPToolMap[K]['result']>;
        if (tool === 'minions') return Promise.resolve({ minions: [] }) as unknown as Promise<MCPToolMap[K]['result']>;
        return new Promise(resolve => setTimeout(() => resolve({ lairName: 'Test', wings: [], availableWorkRepos: [] } as unknown as MCPToolMap[K]['result']), 1000));
      }
    );

    const wrapper = mount(LairOverview);
    // Switching tabs is a same-tick reactivity update — it does not touch the
    // still-pending 1000ms lair_get_state mock, so loading is still true here.
    await openWingsTab(wrapper);

    expect(wrapper.text()).toContain('Waking up the lair');
  });

  it('shows error message on failure', async () => {
    vi.spyOn(cabinet, 'callMCPThrone').mockImplementation(
      <K extends keyof MCPToolMap>(tool: K): Promise<MCPToolMap[K]['result']> => {
        if (tool === 'ask') return Promise.resolve({ questions: [] }) as unknown as Promise<MCPToolMap[K]['result']>;
        if (tool === 'minions') return Promise.resolve({ minions: [] }) as unknown as Promise<MCPToolMap[K]['result']>;
        return Promise.reject(new Error('Failed to load'));
      }
    );

    const wrapper = mount(LairOverview);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));
    await openWingsTab(wrapper);

    expect(wrapper.text()).toContain('Error');
    expect(wrapper.text()).toContain('Failed to load');
  });

  it('shows empty state when no wings', async () => {
    createToolMock({
      lairName: 'Test',
      wings: [],
      availableWorkRepos: []
    });

    const wrapper = mount(LairOverview);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));
    await openWingsTab(wrapper);

    expect(wrapper.text()).toContain('Your lair is empty');
  });

  it('shows wing detail when card clicked', async () => {
    const mockWings = [
      { name: 'central-planning', root: '/wings/central-planning' }
    ];

    createToolMock({
      lairName: 'Test',
      wings: mockWings,
      availableWorkRepos: []
    });

    const wrapper = mount(LairOverview);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));
    await openWingsTab(wrapper);

    const header = wrapper.find('.wing-header');
    await header.trigger('click');

    expect(wrapper.text()).toContain('Root');
    expect(wrapper.text()).toContain('Work Directories');
  });

  it('shows create form when button clicked', async () => {
    createToolMock({
      lairName: 'Test',
      wings: [],
      availableWorkRepos: []
    });

    const wrapper = mount(LairOverview);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));
    await openWingsTab(wrapper);

    // Find the "+ Build Wing" button
    const buttons = wrapper.findAll('button');
    const createButton = buttons.find(b => b.text().includes('Build Wing'));
    expect(createButton).toBeDefined();
    await createButton?.trigger('click');

    expect(wrapper.text()).toContain('Build New Wing');
  });

  it('refreshes list after wing created', async () => {
    const mockWings = [{ name: 'existing', root: '/wings/existing' }];
    const newWing = { name: 'new-district', root: '/wings/new-district' };

    const initialState = {
      lairName: 'Test',
      wings: mockWings,
      availableWorkRepos: ['suite']
    };

    const updatedState = {
      lairName: 'Test',
      wings: [...mockWings, newWing],
      availableWorkRepos: ['suite']
    };

    const mcpSpy = vi.spyOn(cabinet, 'callMCPThrone').mockImplementation(
      <K extends keyof MCPToolMap>(tool: K): Promise<MCPToolMap[K]['result']> => {
        if (tool === 'ask') return Promise.resolve({ questions: [] }) as unknown as Promise<MCPToolMap[K]['result']>;
        if (tool === 'lair_get_state' && mcpSpy.mock.calls.length === 1) return Promise.resolve(initialState) as unknown as Promise<MCPToolMap[K]['result']>;
        if (tool === 'lair_get_state') return Promise.resolve(updatedState) as unknown as Promise<MCPToolMap[K]['result']>;
        return Promise.resolve(initialState) as unknown as Promise<MCPToolMap[K]['result']>;
      }
    );

    const wrapper = mount(LairOverview);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));
    await openWingsTab(wrapper);

    // Trigger creation - find the "+ Build Wing" button
    const buttons = wrapper.findAll('button');
    const createButton = buttons.find(b => b.text().includes('Build Wing'));
    expect(createButton).toBeDefined();
    await createButton?.trigger('click');

    const form = wrapper.findComponent({ name: 'WingCreateForm' });
    form.vm.$emit('created', newWing);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    // Should have called MCP throne multiple times
    expect(mcpSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(wrapper.text()).toContain('new-district');
  });

  it('renders API tab button', async () => {
    createToolMock({
      lairName: 'Test',
      wings: [],
      availableWorkRepos: []
    });

    const wrapper = mount(LairOverview);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('API');
    const buttons = wrapper.findAll('button');
    const apiTab = buttons.find(b => b.text() === 'API');
    expect(apiTab).toBeDefined();
  });

  it('switches to Quality view when Quality tab clicked', async () => {
    createToolMock({
      lairName: 'Test',
      wings: [],
      availableWorkRepos: []
    });

    const wrapper = mount(LairOverview);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    const buttons = wrapper.findAll('button');
    const qualityTab = buttons.find(b => b.text() === 'Quality');
    expect(qualityTab).toBeDefined();
    await qualityTab?.trigger('click');

    await wrapper.vm.$nextTick();

    expect(wrapper.find('h2').text()).toBe('Quality');
    expect(wrapper.findComponent({ name: 'QualityPanel' }).exists()).toBe(true);
  });

  it('switches to API view when API tab clicked', async () => {
    createToolMock({
      lairName: 'Test',
      wings: [],
      availableWorkRepos: []
    });

    const wrapper = mount(LairOverview);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    const buttons = wrapper.findAll('button');
    const apiTab = buttons.find(b => b.text() === 'API');
    expect(apiTab).toBeDefined();
    await apiTab?.trigger('click');

    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('Cabinet MCP API');
  });

  it('renders Switchyard tab button and shows it by default', async () => {
    createToolMock({
      lairName: 'Test',
      wings: [],
      availableWorkRepos: []
    });

    const wrapper = mount(LairOverview);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    const buttons = wrapper.findAll('button');
    const switchyardTab = buttons.find(b => b.text() === 'Switchyard');
    expect(switchyardTab).toBeDefined();
    expect(wrapper.find('h2').text()).toBe('Switchyard');
  });

  it('shows close button when wing is open', async () => {
    const mockWings = [
      { name: 'central-planning', root: '/wings/central-planning' }
    ];

    createToolMock({
      lairName: 'Test',
      wings: mockWings,
      availableWorkRepos: []
    });

    const wrapper = mount(LairOverview);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));
    await openWingsTab(wrapper);

    // Open district
    const header = wrapper.find('.wing-header');
    await header.trigger('click');
    await wrapper.vm.$nextTick();

    // Should show close button
    expect(wrapper.find('.close-wing-btn').exists()).toBe(true);
  });

  it('closes wing when close button clicked', async () => {
    const mockWings = [
      { name: 'central-planning', root: '/wings/central-planning' }
    ];

    createToolMock({
      lairName: 'Test',
      wings: mockWings,
      availableWorkRepos: []
    });

    const wrapper = mount(LairOverview);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));
    await openWingsTab(wrapper);

    // Open district
    const header = wrapper.find('.wing-header');
    await header.trigger('click');
    await wrapper.vm.$nextTick();

    // Click close button
    const closeBtn = wrapper.find('.close-wing-btn');
    await closeBtn.trigger('click');
    await wrapper.vm.$nextTick();

    // Wing detail should be hidden
    expect(wrapper.findComponent({ name: 'WingManagement' }).exists()).toBe(false);
  });

  it('does not close wing when clicking inside WingManagement', async () => {
    const mockWings = [
      { name: 'central-planning', root: '/wings/central-planning' }
    ];

    createToolMock({
      lairName: 'Test',
      wings: mockWings,
      availableWorkRepos: []
    });

    const wrapper = mount(LairOverview);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));
    await openWingsTab(wrapper);

    // Open district
    const header = wrapper.find('.wing-header');
    await header.trigger('click');
    await wrapper.vm.$nextTick();

    // Click on the header again (which is now not clickable)
    await header.trigger('click');
    await wrapper.vm.$nextTick();

    // Wing should still be open
    expect(wrapper.findComponent({ name: 'WingManagement' }).exists()).toBe(true);
  });

  it('displays closed wings before open district', async () => {
    const mockWings = [
      { name: 'wing-a', root: '/path/a' },
      { name: 'wing-b', root: '/path/b' },
      { name: 'wing-c', root: '/path/c' }
    ];

    createToolMock({
      lairName: 'Test',
      wings: mockWings,
      availableWorkRepos: []
    });

    const wrapper = mount(LairOverview);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));
    await openWingsTab(wrapper);

    // Open the middle district
    const headers = wrapper.findAll('.wing-header');
    await headers[1].trigger('click'); // Open wing-b
    await wrapper.vm.$nextTick();

    // Get wing names in order
    const cards = wrapper.findAll('.wing-card');
    const names = cards.map(card => {
      const h3 = card.find('h3');
      return h3.text();
    });

    // wing-b should be last, a and c should be before it
    expect(names[names.length - 1]).toBe('wing-b');
    expect(names.slice(0, -1)).toContain('wing-a');
    expect(names.slice(0, -1)).toContain('wing-c');
  });

  // Lair Metaphor Tests
  it('displays "Lair Wings" heading when wings tab is active', async () => {
    createToolMock({
      lairName: 'Test',
      wings: [],
      availableWorkRepos: []
    });

    const wrapper = mount(LairOverview);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));
    await openWingsTab(wrapper);

    const heading = wrapper.find('h2');
    expect(heading.text()).toBe('Lair Wings');
  });

  it('shows empty state with characteristic tone when no wings', async () => {
    createToolMock({
      lairName: 'Test',
      wings: [],
      availableWorkRepos: []
    });

    const wrapper = mount(LairOverview);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));
    await openWingsTab(wrapper);

    const emptyState = wrapper.find('.empty');
    expect(emptyState.text()).toContain('Your lair is empty');
  });
});
