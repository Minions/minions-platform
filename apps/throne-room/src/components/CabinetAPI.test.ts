import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import CabinetAPI from './CabinetAPI.vue';
import * as cabinetAPI from '../api/cabinet';

vi.mock('../api/cabinet');

describe('CabinetAPI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state initially', () => {
    // Promises that never resolve to simulate perpetual loading state
    const neverResolve = () => new Promise<never>(() => undefined);
    vi.mocked(cabinetAPI.listTools).mockReturnValue(neverResolve());
    vi.mocked(cabinetAPI.listPrompts).mockReturnValue(neverResolve());
    vi.mocked(cabinetAPI.listResources).mockReturnValue(neverResolve());

    const wrapper = mount(CabinetAPI);
    expect(wrapper.text()).toContain('Loading');
  });

  it('displays tools after loading', async () => {
    vi.mocked(cabinetAPI.listTools).mockResolvedValue([
      {
        name: 'districts_list',
        description: 'List all districts',
        inputSchema: { type: 'object', properties: {}, required: [] }
      }
    ]);
    vi.mocked(cabinetAPI.listPrompts).mockResolvedValue([]);
    vi.mocked(cabinetAPI.listResources).mockResolvedValue([]);

    const wrapper = mount(CabinetAPI);
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('districts_list');
    expect(wrapper.text()).toContain('List all districts');
  });

  it('displays tool count', async () => {
    vi.mocked(cabinetAPI.listTools).mockResolvedValue([
      { name: 'tool1', description: 'Tool 1', inputSchema: {} },
      { name: 'tool2', description: 'Tool 2', inputSchema: {} }
    ]);
    vi.mocked(cabinetAPI.listPrompts).mockResolvedValue([]);
    vi.mocked(cabinetAPI.listResources).mockResolvedValue([]);

    const wrapper = mount(CabinetAPI);
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('Tools (2)');
  });

  it('handles API errors gracefully', async () => {
    vi.mocked(cabinetAPI.listTools).mockRejectedValue(new Error('Connection failed'));
    vi.mocked(cabinetAPI.listPrompts).mockResolvedValue([]);
    vi.mocked(cabinetAPI.listResources).mockResolvedValue([]);

    const wrapper = mount(CabinetAPI);
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('Connection failed');
  });

  it('displays empty state when no tools available', async () => {
    vi.mocked(cabinetAPI.listTools).mockResolvedValue([]);
    vi.mocked(cabinetAPI.listPrompts).mockResolvedValue([]);
    vi.mocked(cabinetAPI.listResources).mockResolvedValue([]);

    const wrapper = mount(CabinetAPI);
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('No tools available');
  });

  it('displays prompts section', async () => {
    vi.mocked(cabinetAPI.listTools).mockResolvedValue([]);
    vi.mocked(cabinetAPI.listPrompts).mockResolvedValue([
      { name: 'test_prompt', description: 'A test prompt' }
    ]);
    vi.mocked(cabinetAPI.listResources).mockResolvedValue([]);

    const wrapper = mount(CabinetAPI);
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('Prompts (1)');
  });

  it('displays resources section', async () => {
    vi.mocked(cabinetAPI.listTools).mockResolvedValue([]);
    vi.mocked(cabinetAPI.listPrompts).mockResolvedValue([]);
    vi.mocked(cabinetAPI.listResources).mockResolvedValue([
      { uri: 'file:///test', name: 'Test Resource' }
    ]);

    const wrapper = mount(CabinetAPI);
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('Resources (1)');
  });
});
