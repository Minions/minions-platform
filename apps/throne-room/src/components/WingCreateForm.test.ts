import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import WingCreateForm from './WingCreateForm.vue';
import * as cabinet from '../api/cabinet';
import type { MCPToolMap } from '@minions/mcp-types';

vi.mock('../api/cabinet', () => ({
  callMCPThrone: vi.fn(),
  callMCPConductor: vi.fn(),
}));

describe('WingCreateForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock the lair_get_state call by default
    vi.spyOn(cabinet, 'callMCPThrone').mockImplementation(
      <K extends keyof MCPToolMap>(toolName: K): Promise<MCPToolMap[K]['result']> => {
        if (toolName === 'lair_get_state') {
          return Promise.resolve({
            lairName: 'TestCity',
            wings: [],
            availableWorkRepos: ['suite', 'another-repo']
          }) as unknown as Promise<MCPToolMap[K]['result']>;
        }
        return Promise.resolve({}) as unknown as Promise<MCPToolMap[K]['result']>;
      }
    );
    vi.spyOn(cabinet, 'callMCPConductor').mockResolvedValue({} as never);
  });

  it('renders form fields', () => {
    const wrapper = mount(WingCreateForm);

    expect(wrapper.find('input[type="text"]').exists()).toBe(true);
    expect(wrapper.find('textarea').exists()).toBe(true);
    expect(wrapper.find('button[type="submit"]').exists()).toBe(true);
  });

  it('loads available work repos on mount', async () => {
    const wrapper = mount(WingCreateForm);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(cabinet.callMCPThrone).toHaveBeenCalledWith('lair_get_state', {});
    expect(wrapper.find('select option[value="suite"]').exists()).toBe(true);
    expect(wrapper.find('select option[value="another-repo"]').exists()).toBe(true);
  });

  it('validates required fields', async () => {
    const wrapper = mount(WingCreateForm);

    const form = wrapper.find('form');
    await form.trigger('submit');

    expect(wrapper.text()).toContain('required');
  });

  it('calls wings create on submit', async () => {
    vi.spyOn(cabinet, 'callMCPThrone').mockImplementation(
      <K extends keyof MCPToolMap>(toolName: K): Promise<MCPToolMap[K]['result']> => {
        if (toolName === 'lair_get_state') {
          return Promise.resolve({
            lairName: 'TestCity',
            wings: [],
            availableWorkRepos: ['suite', 'another-repo']
          }) as unknown as Promise<MCPToolMap[K]['result']>;
        }
        return Promise.resolve({}) as unknown as Promise<MCPToolMap[K]['result']>;
      }
    );
    vi.spyOn(cabinet, 'callMCPConductor').mockResolvedValue({
      name: 'new-wing',
      root: '/wings/new-wing'
    } as never);

    const wrapper = mount(WingCreateForm);

    // Wait for repos to load
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    await wrapper.find('input[type="text"]').setValue('new-wing');
    await wrapper.find('textarea').setValue('A new wing');
    await wrapper.find('form').trigger('submit');

    expect(cabinet.callMCPConductor).toHaveBeenCalledWith('wings', {
      action: 'create',
      name: 'new-wing',
      description: 'A new wing',
      workLocalRepo: 'suite'
    });
  });

  it('emits created event on success', async () => {
    vi.spyOn(cabinet, 'callMCPThrone').mockImplementation(
      <K extends keyof MCPToolMap>(toolName: K): Promise<MCPToolMap[K]['result']> => {
        if (toolName === 'lair_get_state') {
          return Promise.resolve({
            lairName: 'TestCity',
            wings: [],
            availableWorkRepos: ['suite']
          }) as unknown as Promise<MCPToolMap[K]['result']>;
        }
        return Promise.resolve({}) as unknown as Promise<MCPToolMap[K]['result']>;
      }
    );
    vi.spyOn(cabinet, 'callMCPConductor').mockResolvedValue({
      name: 'new-wing',
      root: '/wings/new-wing'
    } as never);

    const wrapper = mount(WingCreateForm);

    // Wait for repos to load
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    await wrapper.find('input[type="text"]').setValue('new-wing');
    await wrapper.find('textarea').setValue('A new wing');
    await wrapper.find('form').trigger('submit');

    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('created')).toBeTruthy();
  });

  it('shows error on failure', async () => {
    vi.spyOn(cabinet, 'callMCPThrone').mockImplementation((toolName: string) => {
      if (toolName === 'lair_get_state') {
        return Promise.resolve({
          lairName: 'TestCity',
          wings: [],
          availableWorkRepos: ['suite']
        }) as unknown as ReturnType<typeof cabinet.callMCPThrone>;
      }
      return Promise.reject(new Error('Creation failed'));
    });
    vi.spyOn(cabinet, 'callMCPConductor').mockRejectedValue(new Error('Creation failed'));

    const wrapper = mount(WingCreateForm);

    // Wait for repos to load
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    await wrapper.find('input[type="text"]').setValue('new-wing');
    await wrapper.find('textarea').setValue('A new wing');
    await wrapper.find('form').trigger('submit');

    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('Creation failed');
  });

  // Wing Metaphor Tests
  it('displays "Build New Wing" heading', () => {
    const wrapper = mount(WingCreateForm);
    expect(wrapper.find('h3').text()).toBe('Build New Wing');
  });

  it('displays "Wing Name" label', () => {
    const wrapper = mount(WingCreateForm);
    const label = wrapper.find('label[for="name"]');
    expect(label.text()).toContain('Wing Name');
  });

  it('shows "Build Wing" submit button', async () => {
    const wrapper = mount(WingCreateForm);

    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    const submitButton = wrapper.find('button[type="submit"]');
    expect(submitButton.text()).toContain('Build Wing');
  });
});
