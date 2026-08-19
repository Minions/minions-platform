import { describe, it, expect } from 'vitest';
import { resolveExternalServers } from '../src/resolveExternalServers';
import type { CostumeAccessorySummary } from '../src/ClosetReader';

const playwright: CostumeAccessorySummary = {
  name: 'playwright',
  hasMissions: false,
  mcpServers: {
    playwright: { type: 'http', url: 'http://localhost:8931/sse' },
  },
};

const devAndCheck: CostumeAccessorySummary = {
  name: 'dev-and-check',
  hasMissions: true,
  mcpServers: {},
};

const debugger_: CostumeAccessorySummary = {
  name: 'debugger',
  hasMissions: false,
  mcpServers: {
    'nodejs-debugger': { type: 'stdio', command: 'npx', args: ['@modelcontextprotocol/server-node-debug'] },
  },
};

describe('resolveExternalServers', () => {
  it('returns empty object when no costumes are active', () => {
    expect(resolveExternalServers([], [playwright, devAndCheck])).toEqual({});
  });

  it('returns empty object when active costume has no mcp-servers', () => {
    expect(resolveExternalServers(['dev-and-check'], [playwright, devAndCheck])).toEqual({});
  });

  it('returns mcp-servers from a single active costume', () => {
    const result = resolveExternalServers(['playwright'], [playwright, devAndCheck]);
    expect(result).toEqual({
      playwright: { type: 'http', url: 'http://localhost:8931/sse' },
    });
  });

  it('merges mcp-servers from multiple active costumes', () => {
    const result = resolveExternalServers(
      ['playwright', 'debugger'],
      [playwright, devAndCheck, debugger_]
    );
    expect(result).toEqual({
      playwright: { type: 'http', url: 'http://localhost:8931/sse' },
      'nodejs-debugger': { type: 'stdio', command: 'npx', args: ['@modelcontextprotocol/server-node-debug'] },
    });
  });

  it('ignores active costumes not found in closet summaries', () => {
    const result = resolveExternalServers(['unknown-costume'], [playwright]);
    expect(result).toEqual({});
  });

  it('later costume wins on server name collision', () => {
    const alt: CostumeAccessorySummary = {
      name: 'playwright-alt',
      hasMissions: false,
      mcpServers: {
        playwright: { type: 'http', url: 'http://localhost:9999/sse' },
      },
    };
    const result = resolveExternalServers(
      ['playwright', 'playwright-alt'],
      [playwright, alt]
    );
    expect(result['playwright'].url).toBe('http://localhost:9999/sse');
  });

  it('skips inactive costumes even if they have mcp-servers', () => {
    const result = resolveExternalServers(['dev-and-check'], [playwright, devAndCheck]);
    expect('playwright' in result).toBe(false);
  });
});
