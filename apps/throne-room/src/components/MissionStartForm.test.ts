import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import MissionStartForm from './MissionStartForm.vue';
import * as cabinet from '../api/cabinet';
import type { MissionSummary_ } from '@minions/mcp-types';

vi.mock('../api/cabinet', () => ({
  callMCPThrone: vi.fn(),
  callMCPConductor: vi.fn(),
}));

describe('MissionStartForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseMission: MissionSummary_ = {
    costume: 'test-costume',
    name: 'test-mission',
    description: 'A test mission',
    isLegacy: false,
    runnable: true
  };

  it('displays mission name and costume', () => {
    const wrapper = mount(MissionStartForm, {
      props: {
        wingName: 'test-wing',
        mission: baseMission
      }
    });

    expect(wrapper.text()).toContain('test-mission');
    expect(wrapper.text()).toContain('test-costume');
    expect(wrapper.text()).toContain('A test mission');
  });

  it('shows non-deterministic badge for non-deterministic missions', () => {
    const nonDeterministicMission: MissionSummary_ = {
      ...baseMission,
      isLegacy: true
    };

    const wrapper = mount(MissionStartForm, {
      props: {
        wingName: 'test-wing',
        mission: nonDeterministicMission
      }
    });

    expect(wrapper.find('.legacy-badge').exists()).toBe(true);
    expect(wrapper.text()).toContain('Non-deterministic');
  });

  it('shows no-args message when mission has no arguments', () => {
    const wrapper = mount(MissionStartForm, {
      props: {
        wingName: 'test-wing',
        mission: baseMission
      }
    });

    expect(wrapper.text()).toContain('no arguments');
  });

  it('generates form fields from argsSchema', async () => {
    const missionWithArgs: MissionSummary_ = {
      ...baseMission,
      argsSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The message to echo' },
          count: { type: 'number', description: 'How many times' }
        },
        required: ['message']
      }
    };

    const wrapper = mount(MissionStartForm, {
      props: {
        wingName: 'test-wing',
        mission: missionWithArgs
      }
    });

    // Should have input fields for message and count
    expect(wrapper.find('#arg-message').exists()).toBe(true);
    expect(wrapper.find('#arg-count').exists()).toBe(true);

    // Required field should have asterisk
    expect(wrapper.text()).toContain('message');
    expect(wrapper.find('label').text()).toContain('*');
  });

  it('generates checkbox for boolean arguments', async () => {
    const missionWithBoolean: MissionSummary_ = {
      ...baseMission,
      argsSchema: {
        type: 'object',
        properties: {
          verbose: { type: 'boolean', description: 'Enable verbose output' }
        }
      }
    };

    const wrapper = mount(MissionStartForm, {
      props: {
        wingName: 'test-wing',
        mission: missionWithBoolean
      }
    });

    const checkbox = wrapper.find('#arg-verbose');
    expect(checkbox.exists()).toBe(true);
    expect(checkbox.attributes('type')).toBe('checkbox');
  });

  it('generates dropdown for enum arguments', async () => {
    const missionWithEnum: MissionSummary_ = {
      ...baseMission,
      argsSchema: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            description: 'Output format',
            enum: ['json', 'yaml', 'text']
          }
        }
      }
    };

    const wrapper = mount(MissionStartForm, {
      props: {
        wingName: 'test-wing',
        mission: missionWithEnum
      }
    });

    const select = wrapper.find('#arg-format');
    expect(select.exists()).toBe(true);
    expect(select.element.tagName).toBe('SELECT');

    const options = select.findAll('option');
    // First option is placeholder + 3 enum values
    expect(options.length).toBe(4);
  });

  it('starts mission with form values on submit', async () => {
    const missionWithArgs: MissionSummary_ = {
      ...baseMission,
      argsSchema: {
        type: 'object',
        properties: {
          message: { type: 'string' }
        }
      }
    };

    vi.spyOn(cabinet, 'callMCPConductor').mockResolvedValue({
      missionRunId: 'run-123',
      missionName: 'test-mission',
      costume: 'test-costume'
    });

    const wrapper = mount(MissionStartForm, {
      props: {
        wingName: 'test-wing',
        mission: missionWithArgs
      }
    });

    // Fill in the form
    await wrapper.find('#arg-message').setValue('Hello World');

    // Submit
    await wrapper.find('form').trigger('submit.prevent');
    await wrapper.vm.$nextTick();

    expect(cabinet.callMCPConductor).toHaveBeenCalledWith('missions', {
      action: 'start',
      wingName: 'test-wing',
      costume: 'test-costume',
      mission: 'test-mission',
      args: { message: 'Hello World' }
    });
  });

  it('emits started event on successful submission', async () => {
    const mockResult = {
      missionRunId: 'run-123',
      missionName: 'test-mission',
      costume: 'test-costume'
    };

    vi.spyOn(cabinet, 'callMCPConductor').mockResolvedValue(mockResult);

    const wrapper = mount(MissionStartForm, {
      props: {
        wingName: 'test-wing',
        mission: baseMission
      }
    });

    await wrapper.find('form').trigger('submit.prevent');
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    const startedEvents = wrapper.emitted('started');
    expect(startedEvents).toBeTruthy();
    expect(startedEvents?.[0]).toEqual([mockResult]);
  });

  it('emits cancel event when cancel button clicked', async () => {
    const wrapper = mount(MissionStartForm, {
      props: {
        wingName: 'test-wing',
        mission: baseMission
      }
    });

    await wrapper.find('button[type="button"]').trigger('click');

    expect(wrapper.emitted('cancel')).toBeTruthy();
  });

  it('shows error on failed submission', async () => {
    vi.spyOn(cabinet, 'callMCPConductor').mockRejectedValue(
      new Error('Mission failed to start')
    );

    const wrapper = mount(MissionStartForm, {
      props: {
        wingName: 'test-wing',
        mission: baseMission
      }
    });

    await wrapper.find('form').trigger('submit.prevent');
    await wrapper.vm.$nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('Mission failed to start');
  });

  it('disables buttons while starting', async () => {
    // Create a promise that we can control
    let resolvePromise!: (value: unknown) => void;
    const pendingPromise = new Promise(resolve => {
      resolvePromise = resolve;
    });

    vi.spyOn(cabinet, 'callMCPConductor').mockReturnValue(pendingPromise as ReturnType<typeof cabinet.callMCPConductor>);

    const wrapper = mount(MissionStartForm, {
      props: {
        wingName: 'test-wing',
        mission: baseMission
      }
    });

    // Trigger submit but don't await
    wrapper.find('form').trigger('submit.prevent');
    await wrapper.vm.$nextTick();

    // Buttons should be disabled
    const submitButton = wrapper.find('.start-button');
    expect(submitButton.attributes('disabled')).toBeDefined();
    expect(submitButton.text()).toContain('Starting...');

    // Resolve to cleanup
    resolvePromise({ missionRunId: 'test', missionName: 'test', costume: 'test' });
  });

  // ========== Give-demo specific tests ==========

  describe('give-demo mission', () => {
    const giveDemoMission: MissionSummary_ = {
      costume: 'dev-and-check',
      name: 'give-demo',
      description: 'Run a guided demo',
      isLegacy: false,
      runnable: true,
      argsSchema: {
        type: 'object',
        properties: {
          slicePath: { type: 'string', description: 'Path to the demo slice' }
        },
        required: ['slicePath']
      }
    };

    const mockWings = [
      { name: 'wing-a', root: '/wings/wing-a' },
      { name: 'wing-b', root: '/wings/wing-b' }
    ];

    const mockDemos = [
      { slicePath: 'my-feature/slices/demo', title: 'My Feature Demo' },
      { slicePath: 'other/slices/demo', title: 'Other Demo' }
    ];

    function setupGiveDemoMocks() {
      vi.spyOn(cabinet, 'callMCPThrone').mockImplementation(((toolName: string, _args: Record<string, unknown>) => {
        if (toolName === 'lair_get_state') {
          return Promise.resolve({ lairName: 'test', wings: mockWings, availableWorkRepos: [] });
        }
        return Promise.resolve({});
      }) as typeof cabinet.callMCPThrone);
      vi.spyOn(cabinet, 'callMCPConductor').mockImplementation(((toolName: string, _args: Record<string, unknown>) => {
        if (toolName === 'demos_list') {
          return Promise.resolve({ demos: mockDemos });
        }
        if (toolName === 'missions') {
          return Promise.resolve({ missionRunId: 'run-1', missionName: 'give-demo', costume: 'dev-and-check' });
        }
        return Promise.resolve({});
      }) as typeof cabinet.callMCPConductor);
    }

    it('renders wing and demo dropdowns instead of text input for slicePath', async () => {
      setupGiveDemoMocks();

      const wrapper = mount(MissionStartForm, {
        props: { wingName: 'wing-a', mission: giveDemoMission }
      });
      await wrapper.vm.$nextTick();
      await new Promise(resolve => setTimeout(resolve, 0));
      await wrapper.vm.$nextTick();

      // Should have wing and demo selects
      expect(wrapper.find('#demo-wing-select').exists()).toBe(true);
      expect(wrapper.find('#demo-select').exists()).toBe(true);

      // Should NOT have a plain text input for slicePath
      expect(wrapper.find('#arg-slicePath').exists()).toBe(false);
    });

    it('calls lair_get_state on mount for give-demo', async () => {
      setupGiveDemoMocks();

      mount(MissionStartForm, {
        props: { wingName: 'wing-a', mission: giveDemoMission }
      });
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(cabinet.callMCPThrone).toHaveBeenCalledWith('lair_get_state', {});
    });

    it('calls demos_list on mount with current wingName', async () => {
      setupGiveDemoMocks();

      mount(MissionStartForm, {
        props: { wingName: 'wing-a', mission: giveDemoMission }
      });
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(cabinet.callMCPConductor).toHaveBeenCalledWith('demos_list', { wingName: 'wing-a' });
    });

    it('populates demo dropdown with demos from demos_list', async () => {
      setupGiveDemoMocks();

      const wrapper = mount(MissionStartForm, {
        props: { wingName: 'wing-a', mission: giveDemoMission }
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      await wrapper.vm.$nextTick();

      const demoSelect = wrapper.find('#demo-select');
      const options = demoSelect.findAll('option');
      // placeholder + 2 demos
      expect(options.length).toBe(3);
      expect(options[1].text()).toBe('My Feature Demo');
      expect(options[2].text()).toBe('Other Demo');
    });

    it('selecting a demo sets the slicePath form value and submits with selected wing', async () => {
      setupGiveDemoMocks();

      const wrapper = mount(MissionStartForm, {
        props: { wingName: 'wing-a', mission: giveDemoMission }
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      await wrapper.vm.$nextTick();

      // Select a demo
      const demoSelect = wrapper.find('#demo-select');
      await demoSelect.setValue('my-feature/slices/demo');

      // Submit
      await wrapper.find('form').trigger('submit.prevent');
      await wrapper.vm.$nextTick();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(cabinet.callMCPConductor).toHaveBeenCalledWith('missions', {
        action: 'start',
        wingName: 'wing-a',
        costume: 'dev-and-check',
        mission: 'give-demo',
        args: { slicePath: 'my-feature/slices/demo' }
      });
    });

    it('non-give-demo missions still render generic text input for string args', async () => {
      const normalMission: MissionSummary_ = {
        costume: 'test-costume',
        name: 'other-mission',
        description: 'Not give-demo',
        isLegacy: false,
        runnable: true,
        argsSchema: {
          type: 'object',
          properties: {
            slicePath: { type: 'string', description: 'A path' }
          }
        }
      };

      const wrapper = mount(MissionStartForm, {
        props: { wingName: 'test-wing', mission: normalMission }
      });

      // Should have plain text input, not demo dropdowns
      expect(wrapper.find('#arg-slicePath').exists()).toBe(true);
      expect(wrapper.find('#demo-wing-select').exists()).toBe(false);
      expect(wrapper.find('#demo-select').exists()).toBe(false);
    });
  });
});
