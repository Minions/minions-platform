/**
 * End-to-end verification of the browser-verify path (M3).
 *
 * Exercises the REAL McpProxy against a REAL chrome-devtools-mcp process driving a
 * REAL headless Chrome. The proxy resolves the shared browser (here a Chrome we launch
 * with M2's buildChromeArgs) and injects `--browserUrl … --experimentalPageIdRouting`
 * by server name — no costume flag, no mocks. Proves the Chrome tools surface through
 * the proxy and can drive a page.
 *
 * Gated behind E2E_BROWSER because it needs a real Chrome and spawns processes:
 *   E2E_BROWSER=1 pnpm --filter @minions/cabinet exec vitest run src/mcp/__tests__/sharedBrowser.e2e.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpProxy, SHARED_BROWSER_SERVER_NAME } from '../McpProxy.js';
import { findChromePath, buildChromeArgs } from '../../browser/chromeLauncher.js';
import { findAvailablePort } from '../../utils/port.js';
import type { McpServerConfig } from '@minions/costumes';

const run = process.env['E2E_BROWSER'] ? describe : describe.skip;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../..');

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
}
function selectedPageId(res: unknown): number | null {
  const m = textOf(res).match(/^(\d+):.*\[selected\]/m);
  return m ? Number(m[1]) : null;
}

async function chromeDevtoolsEntry(): Promise<string> {
  const pkgDir = join(repoRoot, 'costumes/browser-verify/spike/node_modules/chrome-devtools-mcp');
  const pkg = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf-8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['chrome-devtools-mcp'];
  return resolve(pkgDir, bin);
}

async function waitForCdp(port: number, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`Chrome CDP did not come up on port ${port}`);
}

run('browser-verify end-to-end (shared browser via proxy)', () => {
  let chrome: ChildProcess;
  let userDataDir: string;
  let port: number;
  let proxy: McpProxy;

  beforeAll(async () => {
    const exe = findChromePath();
    if (!exe) throw new Error('No Chrome found (set CHROME_PATH)');
    port = await findAvailablePort(9444);
    userDataDir = await mkdtemp(join(tmpdir(), 'bv-e2e-'));
    chrome = spawn(exe, buildChromeArgs({ port, userDataDir, headless: true }), { stdio: 'ignore' });
    await waitForCdp(port);

    proxy = new McpProxy();
    // Real provider stand-in: returns the Chrome we just launched (M2's service is
    // unit-tested separately; here we verify the proxy→chrome-devtools-mcp→Chrome path).
    proxy.setSharedBrowser({ ensureRunning: async () => ({ browserUrl: `http://127.0.0.1:${port}`, reused: true }) });

    const entry = await chromeDevtoolsEntry();
    const chromeConfig: McpServerConfig = {
      type: 'stdio',
      command: process.execPath,
      args: [entry, '--no-usage-statistics'],
    };
    await proxy.ensureConnected(SHARED_BROWSER_SERVER_NAME, chromeConfig);
  }, 120000);

  afterAll(async () => {
    await proxy?.disconnectAll().catch(() => { /* best-effort cleanup */ });
    chrome?.kill();
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true }).catch(() => { /* best-effort cleanup */ });
  });

  it('surfaces the Chrome DevTools tools through the proxy (prefixed)', async () => {
    const tools = await proxy.listTools(SHARED_BROWSER_SERVER_NAME);
    const names = tools.map((t) => t.name);
    expect(names).toContain('chrome-devtools-mcp__new_page');
    expect(names).toContain('chrome-devtools-mcp__evaluate_script');
  }, 60000);

  it('opens a page and evaluates a script against the shared Chrome', async () => {
    const opened = await proxy.callTool(
      SHARED_BROWSER_SERVER_NAME,
      'chrome-devtools-mcp__new_page',
      { url: 'about:blank' }
    );
    const pageId = selectedPageId(opened);
    expect(pageId).not.toBeNull();

    const result = await proxy.callTool(
      SHARED_BROWSER_SERVER_NAME,
      'chrome-devtools-mcp__evaluate_script',
      { pageId, function: '() => 6 * 7' }
    );
    expect(textOf(result)).toContain('42');
  }, 60000);
});
