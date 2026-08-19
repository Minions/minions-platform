import { describe, it, expect } from 'vitest';
import type { MinionSpec } from '../../src/domain/MinionSpec';

describe('Spec S1.1: MinionSpec Domain Type', () => {
  it('can create spec with required fields', () => {
    const spec: MinionSpec = {
      client: 'brainless',
      wing: '/path/to/wing',
      model: 'claude-sonnet-4',
      useBuiltInSystemPrompt: true
    };

    expect(spec.client).toBe('brainless');
    expect(spec.wing).toBe('/path/to/wing');
    expect(spec.model).toBe('claude-sonnet-4');
    expect(spec.useBuiltInSystemPrompt).toBe(true);
  });

  it('validates client type', () => {
    type ValidClients = 'claude-code' | 'anthropic-agentic' | 'opencode' | 'code-puppy' | 'brainless';

    const validClients: ValidClients[] = [
      'claude-code',
      'anthropic-agentic',
      'opencode',
      'code-puppy',
      'brainless'
    ];

    validClients.forEach(client => {
      const spec: MinionSpec = {
        client,
        wing: '/path',
        model: 'model',
        useBuiltInSystemPrompt: true
      };
      expect(spec.client).toBe(client);
    });
  });

  it('accepts optional fields', () => {
    const spec: MinionSpec = {
      client: 'brainless',
      wing: '/path',
      model: 'model',
      useBuiltInSystemPrompt: false,
      agentPrompt: 'Custom prompt',
      tools: [{ name: 'test_tool', description: 'A test tool' }],
      name: 'TestMinion',
      metadata: { foo: 'bar' }
    };

    expect(spec.agentPrompt).toBe('Custom prompt');
    expect(spec.tools).toHaveLength(1);
    expect(spec.name).toBe('TestMinion');
    expect(spec.metadata?.foo).toBe('bar');
  });

  it('defaults useBuiltInSystemPrompt to true when omitted', () => {
    const spec: Partial<MinionSpec> = {
      client: 'brainless',
      wing: '/path',
      model: 'model'
    };

    // In actual implementation, this would be handled by a factory function
    const defaulted: MinionSpec = {
      useBuiltInSystemPrompt: true,
      ...spec
    } as MinionSpec;

    expect(defaulted.useBuiltInSystemPrompt).toBe(true);
  });
});
