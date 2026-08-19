import { describe, it, expect, vi } from 'vitest';
import { Schema } from 'effect';
import { buildSpecFromCostume, type ExtendedMinionSpec } from './CostumeSpec';
import type { Costume } from './Costume';
import type { Tool } from '@minions/domain-types';
import { defineEvent } from './EventDeclaration';
import { buildCostumeEvent } from '../test-utils/costumeEventFixture.js';

describe('CostumeSpec', () => {
  describe('buildSpecFromCostume', () => {
    // Helper to create a minimal costume
    const createMinimalCostume = (): Costume => ({
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'Test system prompt',
      gadgets: [],
      skills: [],
      events: [],
      injectFacts: [],
    });

    // Helper to create a full costume
    const createFullCostume = (): Costume => {
      const readTool: Tool = {
        name: 'Read',
        description: 'Read file contents',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      };

      const writeTool: Tool = {
        name: 'Write',
        description: 'Write file contents',
        input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
      };

      const testEvent = defineEvent<{ taskId: string }>(
        'task-complete',
        Schema.Struct({ taskId: Schema.String })
      );

      return {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'You are a developer agent',
        gadgets: [readTool, writeTool],
        skills: [{ name: 'test-skill' }],
        events: [buildCostumeEvent(testEvent, 'Emit when task is done')],
        injectFacts: ['build', 'test', 'structure'],
      };
    };

    describe('basic construction', () => {
      it('constructs spec from minimal costume with no overrides', () => {
        const costume = createMinimalCostume();
        const spec = buildSpecFromCostume(costume);

        expect(spec.model).toBe('claude-sonnet-4-20250514');
        expect(spec.agentPrompt).toBe('Test system prompt');
        expect(spec.tools).toEqual([]);
        expect(spec.skills).toEqual([]);
        expect(spec.events).toEqual([]);
        expect(spec.injectFacts).toEqual([]);
        expect(spec.client).toBe('brainless'); // default
        expect(spec.wing).toBe(''); // default
        expect(spec.useBuiltInSystemPrompt).toBe(false); // default
      });

      it('constructs spec from full costume with all properties', () => {
        const costume = createFullCostume();
        const spec = buildSpecFromCostume(costume);

        expect(spec.model).toBe('claude-sonnet-4-20250514');
        // agentPrompt should include original prompt plus event guidance
        expect(spec.agentPrompt).toContain('You are a developer agent');
        expect(spec.agentPrompt).toContain('You can emit the following events:');
        expect(spec.tools).toHaveLength(2);
        expect(spec.tools?.[0].name).toBe('Read');
        expect(spec.tools?.[1].name).toBe('Write');
        expect(spec.skills).toHaveLength(1);
        expect(spec.events).toHaveLength(1);
        expect(spec.events?.[0].guidance).toBe('Emit when task is done');
        expect(spec.injectFacts).toEqual(['build', 'test', 'structure']);
      });

      it('constructs spec with client and wing from overrides', () => {
        const costume = createMinimalCostume();
        const spec = buildSpecFromCostume(costume, {
          client: 'claude-code',
          wing: '/path/to/wing',
        });

        expect(spec.client).toBe('claude-code');
        expect(spec.wing).toBe('/path/to/wing');
      });

      it('constructs spec with name and metadata from overrides', () => {
        const costume = createMinimalCostume();
        const spec = buildSpecFromCostume(costume, {
          name: 'developer-minion',
          metadata: { task: 'implement-feature' },
        });

        expect(spec.name).toBe('developer-minion');
        expect(spec.metadata).toEqual({ task: 'implement-feature' });
      });
    });

    describe('property mapping', () => {
      it('maps costume.model to spec.model', () => {
        const costume = createMinimalCostume();
        const spec = buildSpecFromCostume(costume);

        expect(spec.model).toBe(costume.model);
      });

      it('maps costume.systemPrompt to spec.agentPrompt', () => {
        const costume = createMinimalCostume();
        const spec = buildSpecFromCostume(costume);

        expect(spec.agentPrompt).toBe(costume.systemPrompt);
      });

      it('maps costume.gadgets to spec.tools', () => {
        const costume = createFullCostume();
        const spec = buildSpecFromCostume(costume);

        expect(spec.tools).toBe(costume.gadgets);
      });

      it('stores costume.skills in spec.skills', () => {
        const costume = createFullCostume();
        const spec = buildSpecFromCostume(costume);

        expect(spec.skills).toBe(costume.skills);
      });

      it('stores costume.events in spec.events', () => {
        const costume = createFullCostume();
        const spec = buildSpecFromCostume(costume);

        expect(spec.events).toBe(costume.events);
      });

      it('stores costume.injectFacts in spec.injectFacts', () => {
        const costume = createFullCostume();
        const spec = buildSpecFromCostume(costume);

        expect(spec.injectFacts).toBe(costume.injectFacts);
      });
    });

    describe('override precedence', () => {
      it('overrides take precedence over costume.model', () => {
        const costume = createMinimalCostume();
        const spec = buildSpecFromCostume(costume, {
          model: 'claude-opus-4-20250514',
        });

        expect(spec.model).toBe('claude-opus-4-20250514');
      });

      it('overrides take precedence over costume.systemPrompt', () => {
        const costume = createMinimalCostume();
        const spec = buildSpecFromCostume(costume, {
          agentPrompt: 'Override prompt',
        });

        expect(spec.agentPrompt).toBe('Override prompt');
      });

      it('overrides take precedence over costume.gadgets', () => {
        const costume = createFullCostume();
        const overrideTool: Tool = {
          name: 'Override',
          description: 'Override tool',
        };
        const spec = buildSpecFromCostume(costume, {
          tools: [overrideTool],
        });

        expect(spec.tools).toHaveLength(1);
        expect(spec.tools?.[0].name).toBe('Override');
      });

      it('overrides take precedence over costume.skills', () => {
        const costume = createFullCostume();
        const spec = buildSpecFromCostume(costume, {
          skills: [{ name: 'override-skill' }],
        });

        expect(spec.skills).toHaveLength(1);
        if (!spec.skills) throw new Error('expected spec.skills to be set');
        const skill = spec.skills[0] as { name: string };
        expect(skill.name).toBe('override-skill');
      });

      it('overrides take precedence over costume.events', () => {
        const costume = createFullCostume();
        const overrideEvent = defineEvent<{ result: string }>(
          'override-event',
          Schema.Struct({ result: Schema.String })
        );
        const spec = buildSpecFromCostume(costume, {
          events: [buildCostumeEvent(overrideEvent, 'Override guidance')],
        });

        expect(spec.events).toHaveLength(1);
        expect(spec.events?.[0].event.type).toBe('override-event');
      });

      it('overrides take precedence over costume.injectFacts', () => {
        const costume = createFullCostume();
        const spec = buildSpecFromCostume(costume, {
          injectFacts: ['override-fact'],
        });

        expect(spec.injectFacts).toEqual(['override-fact']);
      });

      it('allows partial overrides', () => {
        const costume = createFullCostume();
        const spec = buildSpecFromCostume(costume, {
          agentPrompt: 'Override prompt',
          // Other properties should come from costume
        });

        // When agentPrompt is explicitly overridden, event guidance is NOT appended
        // (per buildSpecFromCostume documentation: "Event guidance is NOT appended
        // if agentPrompt is explicitly overridden")
        expect(spec.agentPrompt).toBe('Override prompt');
        expect(spec.model).toBe(costume.model);
        expect(spec.tools).toBe(costume.gadgets);
        expect(spec.skills).toBe(costume.skills);
      });
    });

    describe('partial costume support', () => {
      it('constructs spec from costume with empty arrays', () => {
        const costume: Costume = {
          model: 'claude-sonnet-4-20250514',
          systemPrompt: 'Minimal costume',
          gadgets: [],
          skills: [],
          events: [],
          injectFacts: [],
        };

        const spec = buildSpecFromCostume(costume);

        expect(spec.tools).toEqual([]);
        expect(spec.skills).toEqual([]);
        expect(spec.events).toEqual([]);
        expect(spec.injectFacts).toEqual([]);
      });

      it('constructs spec from costume with only some properties populated', () => {
        const readTool: Tool = { name: 'Read', description: 'Read files' };
        const costume: Costume = {
          model: 'claude-sonnet-4-20250514',
          systemPrompt: 'Partial costume',
          gadgets: [readTool],
          skills: [], // empty
          events: [], // empty
          injectFacts: ['build'], // one item
        };

        const spec = buildSpecFromCostume(costume);

        expect(spec.tools).toHaveLength(1);
        expect(spec.skills).toEqual([]);
        expect(spec.events).toEqual([]);
        expect(spec.injectFacts).toEqual(['build']);
      });
    });

    describe('model compatibility validation', () => {
      it('allows compatible model with client', () => {
        const costume = createMinimalCostume();

        // These should not throw
        expect(() => buildSpecFromCostume(costume, { client: 'claude-code' })).not.toThrow();
        expect(() => buildSpecFromCostume(costume, { client: 'anthropic-agentic' })).not.toThrow();
        expect(() => buildSpecFromCostume(costume, { client: 'brainless' })).not.toThrow();
      });

      it('rejects incompatible model with client', () => {
        const costume = createMinimalCostume();

        // Claude model with OpenAI client should fail
        expect(() => buildSpecFromCostume(costume, { client: 'opencode' })).toThrow(
          /not compatible with client type/
        );
      });

      it('validates model from costume', () => {
        const costume: Costume = {
          ...createMinimalCostume(),
          model: 'gpt-4',
        };

        // GPT-4 with Claude client should fail
        expect(() => buildSpecFromCostume(costume, { client: 'claude-code' })).toThrow(
          /not compatible with client type/
        );
      });

      it('validates model from override', () => {
        const costume = createMinimalCostume();

        // Override with incompatible model
        expect(() =>
          buildSpecFromCostume(costume, {
            client: 'claude-code',
            model: 'gpt-4'
          })
        ).toThrow(/not compatible with client type/);
      });

      it('allows any model with brainless client', () => {
        const costume: Costume = {
          ...createMinimalCostume(),
          model: 'unknown-model-xyz',
        };

        // Brainless client accepts any model
        expect(() => buildSpecFromCostume(costume, { client: 'brainless' })).not.toThrow();
      });

      it('warns but allows unknown models with non-brainless clients', () => {
        const costume: Costume = {
          ...createMinimalCostume(),
          model: 'unknown-model-xyz',
        };

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
          // Mock implementation
        });

        // Unknown model with known client - should warn but not throw
        expect(() => buildSpecFromCostume(costume, { client: 'claude-code' })).not.toThrow();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Unknown model "unknown-model-xyz"')
        );

        warnSpy.mockRestore();
      });

      it('includes compatible clients in error message', () => {
        const costume: Costume = {
          ...createMinimalCostume(),
          model: 'gpt-4',
        };

        try {
          buildSpecFromCostume(costume, { client: 'claude-code' });
          expect.fail('Should have thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toContain('Compatible clients:');
          expect((error as Error).message).toContain('opencode');
        }
      });
    });

    describe('useBuiltInSystemPrompt handling', () => {
      it('defaults useBuiltInSystemPrompt to false', () => {
        const costume = createMinimalCostume();
        const spec = buildSpecFromCostume(costume);

        expect(spec.useBuiltInSystemPrompt).toBe(false);
      });

      it('allows overriding useBuiltInSystemPrompt', () => {
        const costume = createMinimalCostume();
        const spec = buildSpecFromCostume(costume, {
          useBuiltInSystemPrompt: true,
        });

        expect(spec.useBuiltInSystemPrompt).toBe(true);
      });
    });

    describe('ExtendedMinionSpec type', () => {
      it('spec satisfies MinionSpec interface', () => {
        const costume = createMinimalCostume();
        const spec: ExtendedMinionSpec = buildSpecFromCostume(costume, {
          client: 'claude-code',
          wing: '/path/to/wing',
        });

        // Verify required MinionSpec properties
        expect(spec.client).toBeDefined();
        expect(spec.wing).toBeDefined();
        expect(spec.model).toBeDefined();
        expect(spec.useBuiltInSystemPrompt).toBeDefined();
      });

      it('spec includes extended properties', () => {
        const costume = createFullCostume();
        const spec: ExtendedMinionSpec = buildSpecFromCostume(costume);

        // Verify extended properties
        expect(spec.skills).toBeDefined();
        expect(spec.events).toBeDefined();
        expect(spec.injectFacts).toBeDefined();
      });
    });

    describe('event guidance generation', () => {
      it('appends event guidance when costume has events', () => {
        const testEvent = defineEvent<{ taskId: string }>(
          'task-complete',
          Schema.Struct({ taskId: Schema.String })
        );

        const costume: Costume = {
          model: 'claude-sonnet-4-20250514',
          systemPrompt: 'You are a developer agent',
          events: [buildCostumeEvent(testEvent, 'Emit when task is done')],
        };

        const spec = buildSpecFromCostume(costume);

        expect(spec.agentPrompt).toContain('You are a developer agent');
        expect(spec.agentPrompt).toContain('You can emit the following events:');
        expect(spec.agentPrompt).toContain('- **task-complete**: Emit when task is done');
        expect(spec.agentPrompt).toContain("Use get_event_schema('task-complete') to see payload structure");
        expect(spec.agentPrompt).toContain("emit_event('task-complete', payload) to emit");
      });

      it('appends guidance for multiple events', () => {
        const taskEvent = defineEvent<{ taskId: string }>(
          'task-complete',
          Schema.Struct({ taskId: Schema.String })
        );

        const blockedEvent = defineEvent<{ reason: string }>(
          'blocked',
          Schema.Struct({ reason: Schema.String })
        );

        const costume: Costume = {
          model: 'claude-sonnet-4-20250514',
          systemPrompt: 'You are a developer agent',
          events: [
            buildCostumeEvent(taskEvent, 'Emit when task is done'),
            buildCostumeEvent(blockedEvent, 'Emit when you encounter a blocker'),
          ],
        };

        const spec = buildSpecFromCostume(costume);

        expect(spec.agentPrompt).toContain('You are a developer agent');
        expect(spec.agentPrompt).toContain('You can emit the following events:');
        expect(spec.agentPrompt).toContain('- **task-complete**: Emit when task is done');
        expect(spec.agentPrompt).toContain('- **blocked**: Emit when you encounter a blocker');
        expect(spec.agentPrompt).toContain("get_event_schema('task-complete')");
        expect(spec.agentPrompt).toContain("get_event_schema('blocked')");
      });

      it('does not append guidance when costume has no events', () => {
        const costume: Costume = {
          model: 'claude-sonnet-4-20250514',
          systemPrompt: 'You are a developer agent',
          events: [],
        };

        const spec = buildSpecFromCostume(costume);

        expect(spec.agentPrompt).toBe('You are a developer agent');
        expect(spec.agentPrompt).not.toContain('You can emit the following events');
      });

      it('does not append guidance when costume events is undefined', () => {
        const costume: Costume = {
          model: 'claude-sonnet-4-20250514',
          systemPrompt: 'You are a developer agent',
          // events is undefined
        };

        const spec = buildSpecFromCostume(costume);

        expect(spec.agentPrompt).toBe('You are a developer agent');
        expect(spec.agentPrompt).not.toContain('You can emit the following events');
      });

      it('adds only guidance when systemPrompt is undefined', () => {
        const testEvent = defineEvent<{ taskId: string }>(
          'task-complete',
          Schema.Struct({ taskId: Schema.String })
        );

        const costume: Costume = {
          model: 'claude-sonnet-4-20250514',
          // systemPrompt is undefined
          events: [buildCostumeEvent(testEvent, 'Emit when task is done')],
        };

        const spec = buildSpecFromCostume(costume);

        expect(spec.agentPrompt).toContain('You can emit the following events:');
        expect(spec.agentPrompt).toContain('- **task-complete**: Emit when task is done');
        expect(spec.agentPrompt).not.toContain('undefined');
      });

      it('uses override events for guidance generation', () => {
        const costumeEvent = defineEvent<{ taskId: string }>(
          'task-complete',
          Schema.Struct({ taskId: Schema.String })
        );

        const overrideEvent = defineEvent<{ result: string }>(
          'override-event',
          Schema.Struct({ result: Schema.String })
        );

        const costume: Costume = {
          model: 'claude-sonnet-4-20250514',
          systemPrompt: 'You are a developer agent',
          events: [buildCostumeEvent(costumeEvent, 'Emit when task is done')],
        };

        const spec = buildSpecFromCostume(costume, {
          events: [buildCostumeEvent(overrideEvent, 'Override guidance')],
        });

        // Should use override event, not costume event
        expect(spec.agentPrompt).toContain('- **override-event**: Override guidance');
        expect(spec.agentPrompt).not.toContain('task-complete');
      });

      it('preserves newlines between system prompt and guidance', () => {
        const testEvent = defineEvent<{ taskId: string }>(
          'task-complete',
          Schema.Struct({ taskId: Schema.String })
        );

        const costume: Costume = {
          model: 'claude-sonnet-4-20250514',
          systemPrompt: 'You are a developer agent',
          events: [buildCostumeEvent(testEvent, 'Emit when task is done')],
        };

        const spec = buildSpecFromCostume(costume);

        // Should have two newlines between sections
        expect(spec.agentPrompt).toContain('You are a developer agent\n\nYou can emit the following events:');
      });
    });

    describe('edge cases', () => {
      it('handles undefined optional overrides', () => {
        const costume = createMinimalCostume();
        const spec = buildSpecFromCostume(costume, {
          name: undefined,
          metadata: undefined,
        });

        expect(spec.name).toBeUndefined();
        expect(spec.metadata).toBeUndefined();
      });

      it('handles empty string for wing', () => {
        const costume = createMinimalCostume();
        const spec = buildSpecFromCostume(costume, {
          wing: '',
        });

        expect(spec.wing).toBe('');
      });

      it('handles empty string for agentPrompt override', () => {
        const costume = createMinimalCostume();
        const spec = buildSpecFromCostume(costume, {
          agentPrompt: '',
        });

        expect(spec.agentPrompt).toBe('');
      });

      it('preserves reference to costume arrays when not overridden', () => {
        const costume = createFullCostume();
        const spec = buildSpecFromCostume(costume);

        // Arrays should be same reference (not copied)
        expect(spec.tools).toBe(costume.gadgets);
        expect(spec.skills).toBe(costume.skills);
        expect(spec.events).toBe(costume.events);
        expect(spec.injectFacts).toBe(costume.injectFacts);
      });

      it('uses override arrays as-is (does not merge)', () => {
        const costume = createFullCostume();
        const overrideTool: Tool = { name: 'Override', description: 'Override tool' };
        const spec = buildSpecFromCostume(costume, {
          tools: [overrideTool],
        });

        // Should have only the override tool, not merged with costume tools
        expect(spec.tools).toHaveLength(1);
        expect(spec.tools?.[0].name).toBe('Override');
      });
    });

    describe('event guidance in agentPrompt', () => {
      it('appends event guidance when costume has events', () => {
        const testEvent = defineEvent<{ taskId: string }>(
          'task-complete',
          Schema.Struct({ taskId: Schema.String })
        );
        const costume: Costume = {
          model: 'claude-sonnet-4-20250514',
          systemPrompt: 'You are a developer agent',
          events: [
            buildCostumeEvent(testEvent, 'Emit when task is done'),
          ],
        };

        const spec = buildSpecFromCostume(costume);

        // Should have original prompt plus event guidance
        expect(spec.agentPrompt).toContain('You are a developer agent');
        expect(spec.agentPrompt).toContain('You can emit the following events:');
        expect(spec.agentPrompt).toContain('**task-complete**: Emit when task is done');
        expect(spec.agentPrompt).toContain("Use get_event_schema('task-complete')");
        expect(spec.agentPrompt).toContain("emit_event('task-complete', payload)");
      });

      it('appends guidance for multiple events', () => {
        const event1 = defineEvent<{ taskId: string }>(
          'task-complete',
          Schema.Struct({ taskId: Schema.String })
        );
        const event2 = defineEvent<{ error: string }>(
          'task-failed',
          Schema.Struct({ error: Schema.String })
        );
        const costume: Costume = {
          model: 'claude-sonnet-4-20250514',
          systemPrompt: 'You are a developer agent',
          events: [
            buildCostumeEvent(event1, 'Emit when task is done'),
            buildCostumeEvent(event2, 'Emit if task fails'),
          ],
        };

        const spec = buildSpecFromCostume(costume);

        expect(spec.agentPrompt).toContain('**task-complete**: Emit when task is done');
        expect(spec.agentPrompt).toContain('**task-failed**: Emit if task fails');
      });

      it('does not append guidance when costume has no events', () => {
        const costume: Costume = {
          model: 'claude-sonnet-4-20250514',
          systemPrompt: 'You are a developer agent',
        };

        const spec = buildSpecFromCostume(costume);

        expect(spec.agentPrompt).toBe('You are a developer agent');
        expect(spec.agentPrompt).not.toContain('You can emit the following events:');
      });

      it('does not append guidance when costume has empty events array', () => {
        const costume: Costume = {
          model: 'claude-sonnet-4-20250514',
          systemPrompt: 'You are a developer agent',
          events: [],
        };

        const spec = buildSpecFromCostume(costume);

        expect(spec.agentPrompt).toBe('You are a developer agent');
        expect(spec.agentPrompt).not.toContain('You can emit the following events:');
      });

      it('handles costume without systemPrompt but with events', () => {
        const testEvent = defineEvent<{ result: string }>(
          'result-ready',
          Schema.Struct({ result: Schema.String })
        );
        const costume: Costume = {
          model: 'claude-sonnet-4-20250514',
          events: [
            buildCostumeEvent(testEvent, 'Emit when result is ready'),
          ],
        };

        const spec = buildSpecFromCostume(costume);

        // Should have event guidance even without base prompt
        expect(spec.agentPrompt).toContain('You can emit the following events:');
        expect(spec.agentPrompt).toContain('**result-ready**: Emit when result is ready');
      });

      it('preserves overridden agentPrompt without adding event guidance', () => {
        const testEvent = defineEvent<{ taskId: string }>(
          'task-complete',
          Schema.Struct({ taskId: Schema.String })
        );
        const costume: Costume = {
          model: 'claude-sonnet-4-20250514',
          systemPrompt: 'Original prompt',
          events: [
            buildCostumeEvent(testEvent, 'Emit when task is done'),
          ],
        };

        const spec = buildSpecFromCostume(costume, {
          agentPrompt: 'Overridden prompt',
        });

        // Overridden prompt should be used as-is, without event guidance
        expect(spec.agentPrompt).toBe('Overridden prompt');
        expect(spec.agentPrompt).not.toContain('You can emit the following events:');
      });

      it('adds event guidance when events are overridden', () => {
        const originalEvent = defineEvent<{ taskId: string }>(
          'original-event',
          Schema.Struct({ taskId: Schema.String })
        );
        const overrideEvent = defineEvent<{ result: string }>(
          'override-event',
          Schema.Struct({ result: Schema.String })
        );
        const costume: Costume = {
          model: 'claude-sonnet-4-20250514',
          systemPrompt: 'You are a developer agent',
          events: [
            buildCostumeEvent(originalEvent, 'Original guidance'),
          ],
        };

        const spec = buildSpecFromCostume(costume, {
          events: [
            buildCostumeEvent(overrideEvent, 'Override guidance'),
          ],
        });

        // Should use overridden events for guidance
        expect(spec.agentPrompt).toContain('**override-event**: Override guidance');
        expect(spec.agentPrompt).not.toContain('original-event');
      });

      it('does not add guidance when events are overridden to empty array', () => {
        const originalEvent = defineEvent<{ taskId: string }>(
          'original-event',
          Schema.Struct({ taskId: Schema.String })
        );
        const costume: Costume = {
          model: 'claude-sonnet-4-20250514',
          systemPrompt: 'You are a developer agent',
          events: [
            buildCostumeEvent(originalEvent, 'Original guidance'),
          ],
        };

        const spec = buildSpecFromCostume(costume, {
          events: [],
        });

        expect(spec.agentPrompt).toBe('You are a developer agent');
        expect(spec.agentPrompt).not.toContain('You can emit the following events:');
      });
    });
  });
});
