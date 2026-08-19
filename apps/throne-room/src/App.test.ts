import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import App from './App.vue';
import WelcomeScreen from './components/WelcomeScreen.vue';
import { router as appRouter } from './router';
import * as cabinet from './api/cabinet';
import type { MCPToolMap } from '@minions/mcp-types';

function makeRouter() {
  return appRouter;
}

vi.mock('./api/cabinet', () => ({
  callMCPThrone: vi.fn(),
  // Switchyard (LairOverview's default tab) calls these on mount; keep it
  // inert for tests here that aren't specifically exercising it.
  callMCPThroneRaw: vi.fn().mockResolvedValue({ minions: [] }),
  getWorkRepoNames: vi.fn().mockResolvedValue([]),
}));

// jsdom's localStorage is not fully functional in this environment — provide a real implementation
const localStorageData: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => localStorageData[key] ?? null,
  setItem: (key: string, value: string) => { localStorageData[key] = String(value); },
  removeItem: (key: string) => { delete localStorageData[key]; },
  clear: () => { Object.keys(localStorageData).forEach(k => delete localStorageData[k]); },
};
vi.stubGlobal('localStorage', localStorageMock);

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

describe('App', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders lair overview', async () => {
    // Set flag to skip welcome screen
    localStorage.setItem('welcomeScreenSeen', 'true');
    createToolMock({ wings: [], lairName: 'Test', availableWorkRepos: [] });

    const router = makeRouter();
    const wrapper = mount(App, { global: { plugins: [router] } });
    await router.isReady();
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('Throne Room');
    // Switchyard is now the default tab (the primary place to interact with wings).
    expect(wrapper.text()).toContain('Switchyard');
  });

  it('shows welcome screen on first visit', async () => {
    createToolMock({ wings: [], lairName: 'Test', availableWorkRepos: [] });

    const wrapper = mount(App, { global: { plugins: [makeRouter()] } });

    // Wait for onMounted lifecycle
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.findComponent(WelcomeScreen).exists()).toBe(true);
    expect(wrapper.text()).toContain('Welcome, Overlord');
  });

  it('hides welcome screen after dismissal', async () => {
    createToolMock({ wings: [], lairName: 'Test', availableWorkRepos: [] });

    const wrapper = mount(App, { global: { plugins: [makeRouter()] } });

    // Wait for onMounted lifecycle
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    // Welcome screen should be visible initially
    expect(wrapper.findComponent(WelcomeScreen).exists()).toBe(true);

    // Emit dismiss event
    await wrapper.findComponent(WelcomeScreen).vm.$emit('dismiss');
    await wrapper.vm.$nextTick();

    // Welcome screen should be hidden
    expect(wrapper.findComponent(WelcomeScreen).exists()).toBe(false);
  });

  it('does not show welcome screen if already seen', () => {
    localStorage.setItem('welcomeScreenSeen', 'true');
    createToolMock({ wings: [], lairName: 'Test', availableWorkRepos: [] });

    const wrapper = mount(App, { global: { plugins: [makeRouter()] } });

    expect(wrapper.findComponent(WelcomeScreen).exists()).toBe(false);
  });

  it('persists welcome screen dismissal in localStorage', async () => {
    createToolMock({ wings: [], lairName: 'Test', availableWorkRepos: [] });

    const wrapper = mount(App, { global: { plugins: [makeRouter()] } });

    // Wait for onMounted lifecycle
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    // Dismiss welcome screen
    await wrapper.findComponent(WelcomeScreen).vm.$emit('dismiss');
    await wrapper.vm.$nextTick();

    // Check localStorage
    expect(localStorage.getItem('welcomeScreenSeen')).toBe('true');
  });
});
