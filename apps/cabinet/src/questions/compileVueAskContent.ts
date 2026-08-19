import type { AskContent } from '@minions/mcp-types';

/**
 * If content is a raw Vue SFC ('vue' type), compile and server-render it to
 * static HTML so the client can display it without shipping an SFC compiler.
 * Other content types pass through unchanged.
 */
export async function resolveAskContent(content: AskContent): Promise<AskContent> {
  if (content.type !== 'vue') return content;

  const [{ loadModule }, vue, { renderToString }] = await Promise.all([
    import('vue3-sfc-loader'),
    import('vue'),
    import('@vue/server-renderer'),
  ]);

  const components = content.components ?? {};
  const moduleCache: Record<string, unknown> = { vue };
  for (const [name, sfcStr] of Object.entries(components)) {
    moduleCache[name] = await loadModule(`${name}.vue`, {
      moduleCache: { vue },
      getFile: () => sfcStr,
      // oxlint-disable-next-line no-empty-function -- vue3-sfc-loader requires this hook; styles aren't needed for server-rendered question components
      addStyle: () => {},
    });
  }

  const component = await loadModule('question.vue', {
    moduleCache,
    getFile: () => content.content,
    // oxlint-disable-next-line no-empty-function -- vue3-sfc-loader requires this hook; styles aren't needed for server-rendered question components
    addStyle: () => {},
  });

  const app = vue.createSSRApp(component);
  const html = await renderToString(app);

  return { type: 'html', content: html };
}
