import { describe, it, expect } from 'vitest';
import { isCostumeConfig, isEntrypoint } from '../src/CostumeConfig';

describe('isEntrypoint', () => {
  it('returns true for valid entrypoint', () => {
    expect(isEntrypoint({ file: 'gadgets/ping.ts', export: 'gadget' })).toBe(true);
  });

  it('returns false for missing file', () => {
    expect(isEntrypoint({ export: 'gadget' })).toBe(false);
  });

  it('returns false for missing export', () => {
    expect(isEntrypoint({ file: 'gadgets/ping.ts' })).toBe(false);
  });

  it('returns false for non-string file', () => {
    expect(isEntrypoint({ file: 123, export: 'gadget' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isEntrypoint(null)).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(isEntrypoint('string')).toBe(false);
  });
});

describe('isCostumeConfig', () => {
  it('returns true for minimal config (model only)', () => {
    expect(isCostumeConfig({ model: 'claude-sonnet-4-20250514' })).toBe(true);
  });

  it('returns true for config with systemPrompt', () => {
    expect(isCostumeConfig({
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'You are a test agent.',
    })).toBe(true);
  });

  it('returns true for config with systemPromptFile', () => {
    expect(isCostumeConfig({
      model: 'claude-sonnet-4-20250514',
      systemPromptFile: 'prompt.md',
    })).toBe(true);
  });

  it('returns true for config with gadgets', () => {
    expect(isCostumeConfig({
      model: 'claude-sonnet-4-20250514',
      gadgets: [
        { file: 'gadgets/ping.ts', export: 'gadget' },
      ],
    })).toBe(true);
  });

  it('returns true for config with events', () => {
    expect(isCostumeConfig({
      model: 'claude-sonnet-4-20250514',
      events: [
        {
          entrypoint: { file: 'events/phase-changed.ts', export: 'event' },
          guidance: 'Emit when phase changes',
        },
      ],
    })).toBe(true);
  });

  it('returns true for config with injectFacts', () => {
    expect(isCostumeConfig({
      model: 'claude-sonnet-4-20250514',
      injectFacts: ['build', 'test'],
    })).toBe(true);
  });

  it('returns true for full config', () => {
    expect(isCostumeConfig({
      model: 'claude-sonnet-4-20250514',
      systemPromptFile: 'prompt.md',
      gadgets: [{ file: 'gadgets/ping.ts', export: 'gadget' }],
      missions: [{ file: 'missions/echo.ts', export: 'mission' }],
      events: [{
        entrypoint: { file: 'events/done.ts', export: 'event' },
        guidance: 'Emit when done',
      }],
      injectFacts: ['build'],
    })).toBe(true);
  });

  it('returns false for missing model', () => {
    expect(isCostumeConfig({ systemPrompt: 'hello' })).toBe(false);
  });

  it('returns false for empty model', () => {
    expect(isCostumeConfig({ model: '' })).toBe(false);
  });

  it('returns false for non-string model', () => {
    expect(isCostumeConfig({ model: 123 })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isCostumeConfig(null)).toBe(false);
  });

  it('returns false for non-string systemPrompt', () => {
    expect(isCostumeConfig({ model: 'x', systemPrompt: 123 })).toBe(false);
  });

  it('returns false for non-string systemPromptFile', () => {
    expect(isCostumeConfig({ model: 'x', systemPromptFile: 123 })).toBe(false);
  });

  it('returns false for non-array gadgets', () => {
    expect(isCostumeConfig({ model: 'x', gadgets: 'bad' })).toBe(false);
  });

  it('returns false for invalid gadget entrypoint', () => {
    expect(isCostumeConfig({
      model: 'x',
      gadgets: [{ file: 'ping.ts' }], // missing export
    })).toBe(false);
  });

  it('returns false for non-array events', () => {
    expect(isCostumeConfig({ model: 'x', events: 'bad' })).toBe(false);
  });

  it('returns false for event missing guidance', () => {
    expect(isCostumeConfig({
      model: 'x',
      events: [{
        entrypoint: { file: 'e.ts', export: 'event' },
        // missing guidance
      }],
    })).toBe(false);
  });

  it('returns false for event with invalid entrypoint', () => {
    expect(isCostumeConfig({
      model: 'x',
      events: [{
        entrypoint: { file: 'e.ts' }, // missing export
        guidance: 'test',
      }],
    })).toBe(false);
  });

  it('returns false for non-array injectFacts', () => {
    expect(isCostumeConfig({ model: 'x', injectFacts: 'bad' })).toBe(false);
  });

  it('returns false for non-string injectFacts items', () => {
    expect(isCostumeConfig({ model: 'x', injectFacts: [123] })).toBe(false);
  });

  it('returns true for accessories with missions: true', () => {
    expect(isCostumeConfig({
      model: 'x',
      accessories: { missions: true },
    })).toBe(true);
  });

  it('returns true for accessories with missions: false', () => {
    expect(isCostumeConfig({
      model: 'x',
      accessories: { missions: false },
    })).toBe(true);
  });

  it('returns true for accessories with mcpServers', () => {
    expect(isCostumeConfig({
      model: 'x',
      accessories: {
        mcpServers: {
          playwright: { type: 'http', url: 'http://localhost:8931/sse' },
        },
      },
    })).toBe(true);
  });

  it('returns true for accessories with stdio mcpServer', () => {
    expect(isCostumeConfig({
      model: 'x',
      accessories: {
        mcpServers: {
          myserver: { type: 'stdio', command: 'npx', args: ['@scope/server'] },
        },
      },
    })).toBe(true);
  });

  it('returns false for non-object accessories', () => {
    expect(isCostumeConfig({ model: 'x', accessories: 'bad' })).toBe(false);
  });

  it('returns false for accessories.missions as non-boolean', () => {
    expect(isCostumeConfig({ model: 'x', accessories: { missions: 'yes' } })).toBe(false);
  });

  it('returns false for accessories.mcpServers as non-object', () => {
    expect(isCostumeConfig({ model: 'x', accessories: { mcpServers: [] } })).toBe(false);
  });

  it('returns false for mcpServer with invalid type', () => {
    expect(isCostumeConfig({
      model: 'x',
      accessories: { mcpServers: { s: { type: 'invalid' } } },
    })).toBe(false);
  });

  it('returns false for mcpServer missing type', () => {
    expect(isCostumeConfig({
      model: 'x',
      accessories: { mcpServers: { s: { url: 'http://x' } } },
    })).toBe(false);
  });
});
