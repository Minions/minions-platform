import { describe, it, expect } from 'vitest';
import { resolveAskContent } from './compileVueAskContent';

describe('resolveAskContent', () => {
  it('passes through non-vue content unchanged', async () => {
    const content = { type: 'markdown' as const, content: '# hi' };
    expect(await resolveAskContent(content)).toEqual(content);
  });

  it('compiles a vue SFC to server-rendered HTML', async () => {
    const result = await resolveAskContent({
      type: 'vue',
      content: `
        <template><div class="greeting">Hello {{ name }}</div></template>
        <script setup>
        const name = 'world';
        </script>
      `,
    });

    expect(result.type).toBe('html');
    expect(result.content).toContain('class="greeting"');
    expect(result.content).toContain('Hello world');
  }, 30000);

  it('resolves named sub-components referenced by the main SFC', async () => {
    const result = await resolveAskContent({
      type: 'vue',
      content: `
        <template><Child /></template>
        <script setup>
        import Child from 'Child';
        </script>
      `,
      components: {
        Child: `<template><span class="child">child content</span></template>`,
      },
    });

    expect(result.type).toBe('html');
    expect(result.content).toContain('class="child"');
    expect(result.content).toContain('child content');
  }, 30000);
});
