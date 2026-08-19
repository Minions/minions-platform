import { describe, it, expect } from 'vitest';
import { Schema } from 'effect';
import { defineEvent } from './EventDeclaration';
import type { Costume, CostumeEvent, Skill } from './Costume';
import type { Tool } from '@minions/domain-types';

describe('Costume', () => {
  describe('Costume interface', () => {
    it('defines a complete costume with all required properties', () => {
      const testGadget: Tool = {
        name: 'Read',
        description: 'Read file contents',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
        },
      };

      const testEvent = defineEvent<{ taskId: string; result: string }>(
        'implementation-complete',
        Schema.Struct({
          taskId: Schema.String,
          result: Schema.String,
        })
      );

      const costume: Costume = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'You are a developer agent...',
        gadgets: [testGadget],
        skills: [],
        events: [
          {
            event: testEvent as unknown as CostumeEvent['event'],
            guidance: 'Emit when feature is fully implemented',
          },
        ],
        injectFacts: ['build', 'package-manager'],
      };

      expect(costume.model).toBe('claude-sonnet-4-20250514');
      expect(costume.systemPrompt).toBe('You are a developer agent...');
      expect(costume.gadgets).toHaveLength(1);
      expect(costume.gadgets?.[0]).toBe(testGadget);
      expect(costume.skills).toHaveLength(0);
      expect(costume.events).toHaveLength(1);
      expect(costume.events?.[0].event.type).toBe('implementation-complete');
      expect(costume.events?.[0].guidance).toBe('Emit when feature is fully implemented');
      expect(costume.injectFacts).toEqual(['build', 'package-manager']);
    });

    it('accepts costume with empty arrays', () => {
      const costume: Costume = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'Minimal costume',
        gadgets: [],
        skills: [],
        events: [],
        injectFacts: [],
      };

      expect(costume.gadgets).toHaveLength(0);
      expect(costume.skills).toHaveLength(0);
      expect(costume.events).toHaveLength(0);
      expect(costume.injectFacts).toHaveLength(0);
    });

    it('accepts costume with multiple gadgets', () => {
      const gadgets: Tool[] = [
        { name: 'Read', description: 'Read files', input_schema: {} },
        { name: 'Write', description: 'Write files', input_schema: {} },
        { name: 'Bash', description: 'Execute commands', input_schema: {} },
      ];

      const costume: Costume = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'Multi-gadget costume',
        gadgets,
        skills: [],
        events: [],
        injectFacts: [],
      };

      expect(costume.gadgets).toHaveLength(3);
      expect(costume.gadgets?.map(g => g.name)).toEqual(['Read', 'Write', 'Bash']);
    });

    it('accepts costume with multiple events', () => {
      const event1 = defineEvent<{ taskId: string }>(
        'task-complete',
        Schema.Struct({ taskId: Schema.String })
      );
      const event2 = defineEvent<{ reason: string }>(
        'blocked',
        Schema.Struct({ reason: Schema.String })
      );

      const costume: Costume = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'Multi-event costume',
        gadgets: [],
        skills: [],
        events: [
          { event: event1 as unknown as CostumeEvent['event'], guidance: 'When task is done' },
          { event: event2 as unknown as CostumeEvent['event'], guidance: 'When blocked' },
        ],
        injectFacts: [],
      };

      expect(costume.events).toHaveLength(2);
      expect(costume.events?.[0].event.type).toBe('task-complete');
      expect(costume.events?.[1].event.type).toBe('blocked');
    });

    it('accepts costume with open-ended fact categories', () => {
      const costume: Costume = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'Custom facts costume',
        gadgets: [],
        skills: [],
        events: [],
        injectFacts: [
          'build',
          'test',
          'package-manager',
          'custom-category',
          'another-custom-category',
        ],
      };

      expect(costume.injectFacts).toHaveLength(5);
      expect(costume.injectFacts).toContain('custom-category');
      expect(costume.injectFacts).toContain('another-custom-category');
    });
  });

  describe('CostumeEvent interface', () => {
    it('defines an event with guidance', () => {
      const eventDecl = defineEvent<{ taskId: string; result: string }>(
        'implementation-complete',
        Schema.Struct({
          taskId: Schema.String,
          result: Schema.String,
        })
      );

      const costumeEvent: CostumeEvent = {
        event: eventDecl as unknown as CostumeEvent['event'],
        guidance: 'Emit when feature is fully implemented and tested',
      };

      expect(costumeEvent.event.type).toBe('implementation-complete');
      expect(costumeEvent.guidance).toBe('Emit when feature is fully implemented and tested');
      expect(costumeEvent.event.schema).toBeDefined();
    });

    it('accepts event without schema', () => {
      const eventDecl = defineEvent<{ taskId: string }>('simple-event');

      const costumeEvent: CostumeEvent = {
        event: eventDecl as unknown as CostumeEvent['event'],
        guidance: 'Simple event guidance',
      };

      expect(costumeEvent.event.type).toBe('simple-event');
      expect(costumeEvent.event.schema).toBeUndefined();
    });

    it('accepts complex event payloads with schemas', () => {
      interface ComplexPayload {
        taskId: string;
        metadata: {
          duration: number;
          linesChanged: number;
        };
        tags: readonly string[];
      }

      const eventDecl = defineEvent<ComplexPayload>(
        'complex-event',
        Schema.Struct({
          taskId: Schema.String,
          metadata: Schema.Struct({
            duration: Schema.Number,
            linesChanged: Schema.Number,
          }),
          tags: Schema.Array(Schema.String),
        })
      );

      const costumeEvent: CostumeEvent = {
        event: eventDecl as unknown as CostumeEvent['event'],
        guidance: 'Emit with complex metadata',
      };

      expect(costumeEvent.event.type).toBe('complex-event');
      expect(costumeEvent.event.schema).toBeDefined();
    });
  });

  describe('Skill type', () => {
    it('is a placeholder type that accepts any value', () => {
      // Skill is unknown, so it can be assigned any value
      const skill1: Skill = { name: 'test-skill' };
      const skill2: Skill = 'string-skill';
      const skill3: Skill = 123;
      const skill4: Skill = undefined;

      // TypeScript should accept all of these without error
      expect(skill1).toBeDefined();
      expect(skill2).toBeDefined();
      expect(skill3).toBeDefined();
      expect(skill4).toBeUndefined();
    });
  });

  describe('Tool type from MinionSpec', () => {
    it('is used for gadgets', () => {
      const gadget: Tool = {
        name: 'test-gadget',
        description: 'A test gadget',
        input_schema: {
          type: 'object',
          properties: {
            param1: { type: 'string' },
          },
        },
      };

      const costume: Costume = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'Test',
        gadgets: [gadget],
        skills: [],
        events: [],
        injectFacts: [],
      };

      expect(costume.gadgets?.[0].name).toBe('test-gadget');
      expect(costume.gadgets?.[0].description).toBe('A test gadget');
    });

    it('accepts minimal tool definition', () => {
      const minimalGadget: Tool = {
        name: 'minimal',
        description: 'Minimal gadget',
      };

      expect(minimalGadget.name).toBe('minimal');
      expect(minimalGadget.input_schema).toBeUndefined();
    });
  });

  describe('type assertions', () => {
    it('ensures all required fields are present', () => {
      // This test verifies type completeness at compile time
      // If a required field is missing, TypeScript will error

      const validCostume: Costume = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'Test costume',
        gadgets: [],
        skills: [],
        events: [],
        injectFacts: [],
      };

      // Verify all fields exist
      expect(validCostume).toHaveProperty('model');
      expect(validCostume).toHaveProperty('systemPrompt');
      expect(validCostume).toHaveProperty('gadgets');
      expect(validCostume).toHaveProperty('skills');
      expect(validCostume).toHaveProperty('events');
      expect(validCostume).toHaveProperty('injectFacts');
    });

    it('ensures CostumeEvent has required fields', () => {
      const event = defineEvent<{ value: string }>(
        'test',
        Schema.Struct({ value: Schema.String })
      );

      const costumeEvent: CostumeEvent = {
        event: event as unknown as CostumeEvent['event'],
        guidance: 'Test guidance',
      };

      expect(costumeEvent).toHaveProperty('event');
      expect(costumeEvent).toHaveProperty('guidance');
    });
  });
});
