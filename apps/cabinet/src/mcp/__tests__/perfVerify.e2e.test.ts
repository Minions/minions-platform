/**
 * End-to-end verification of the perf-verify path (M4).
 *
 * Proves the "Done when" for M4: a HEADLESS perf run on an AUTHENTICATED route
 * produces a raw trace dump + parsed insights WITHOUT manual re-auth.
 *
 * Exercises the REAL McpProxy against TWO real chrome-devtools-mcp processes:
 *   - the SHARED browser (chrome-devtools-mcp, bound to a Chrome we launch), used only
 *     to establish + capture the live session, and
 *   - the dedicated PERF instance (chrome-devtools-mcp-perf), launched
 *     `--isolated --headless --experimentalPageIdRouting --no-performance-crux` exactly
 *     as the costume declares it.
 * The session captured from the shared browser is seeded into the isolated instance via
 * `navigate_page` `initScript`, so it boots authenticated; then a CDP trace is recorded
 * and stopped, yielding insights. No mocks; no second login.
 *
 * Gated behind E2E_BROWSER because it needs a real Chrome and spawns processes:
 *   E2E_BROWSER=1 pnpm --filter @minions/cabinet exec vitest run src/mcp/__tests__/perfVerify.e2e.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpProxy, SHARED_BROWSER_SERVER_NAME } from '../McpProxy.js';
import { findChromePath, buildChromeArgs } from '../../browser/chromeLauncher.js';
import { findAvailablePort } from '../../utils/port.js';
import type { McpServerConfig } from '@minions/costumes';

const run = process.env['E2E_BROWSER'] ? describe : describe.skip;

const PERF_SERVER_NAME = 'chrome-devtools-mcp-perf';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../..');

// Minimal same-origin target whose auth state derives from localStorage + a cookie,
// matching the M1 spike's auth-sim. Lets us prove seeded auth without a real auth app.
const AUTH_SIM_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>auth-sim</title></head>
<body><h1>auth-sim</h1><div id="status">booting</div><script>
  function readCookie(n){return document.cookie.split(';').map(s=>s.trim())
    .filter(s=>s.startsWith(n+'=')).map(s=>s.slice(n.length+1))[0]||'';}
  function render(){var t=localStorage.getItem('authToken')||'';var s=readCookie('session');
    var el=document.getElementById('status');
    if(t||s){el.textContent='AUTHENTICATED token='+t+' session='+s;}else{el.textContent='LOGGED_OUT';}}
  window.__login=function(t,s){localStorage.setItem('authToken',t);
    document.cookie='session='+s+'; path=/; max-age=86400';render();
    return document.getElementById('status').textContent;};
  window.__authState=function(){render();return document.getElementById('status').textContent;};
  render();
</script></body></html>`;

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
}
function selectedPageId(res: unknown): number | null {
  const m = textOf(res).match(/^(\d+):.*\[selected\]/m);
  return m ? Number(m[1]) : null;
}
function evalJson(res: unknown): unknown {
  const text = textOf(res);
  const fenced = text.match(/```json\n([\s\S]*?)\n```/);
  try {
    return JSON.parse(fenced ? fenced[1] : text);
  } catch {
    return text;
  }
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

run('perf-verify end-to-end (isolated-seeded headless record → dump)', () => {
  let target: Server;
  let targetUrl: string;
  let chrome: ChildProcess;
  let userDataDir: string;
  let proxy: McpProxy;

  beforeAll(async () => {
    const exe = findChromePath();
    if (!exe) throw new Error('No Chrome found (set CHROME_PATH)');

    // 1. target app
    const targetPort = await findAvailablePort(4500);
    target = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(AUTH_SIM_PAGE);
    });
    await new Promise<void>((r) => target.listen(targetPort, r));
    targetUrl = `http://localhost:${targetPort}/`;

    // 2. shared Chrome (what the perf run captures its session from)
    const sharedPort = await findAvailablePort(9555);
    userDataDir = await mkdtemp(join(tmpdir(), 'perf-e2e-'));
    chrome = spawn(exe, buildChromeArgs({ port: sharedPort, userDataDir, headless: true }), {
      stdio: 'ignore',
    });
    await waitForCdp(sharedPort);

    // 3. proxy with both servers: shared (bound to our Chrome) + dedicated perf instance
    proxy = new McpProxy();
    proxy.setSharedBrowser({
      ensureRunning: async () => ({ browserUrl: `http://127.0.0.1:${sharedPort}`, reused: true }),
    });

    const entry = await chromeDevtoolsEntry();
    const sharedConfig: McpServerConfig = {
      type: 'stdio',
      command: process.execPath,
      args: [entry, '--no-usage-statistics'],
    };
    const perfConfig: McpServerConfig = {
      type: 'stdio',
      command: process.execPath,
      args: [
        entry,
        '--no-usage-statistics',
        '--isolated',
        '--headless',
        '--experimentalPageIdRouting',
        '--no-performance-crux',
      ],
    };
    await proxy.ensureConnected(SHARED_BROWSER_SERVER_NAME, sharedConfig);
    await proxy.ensureConnected(PERF_SERVER_NAME, perfConfig);
  }, 180000);

  afterAll(async () => {
    await proxy?.disconnectAll().catch(() => { /* best-effort cleanup */ });
    chrome?.kill();
    await new Promise<void>((r) => (target ? target.close(() => r()) : r()));
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true }).catch(() => { /* best-effort */ });
  });

  it('records a trace on a seeded authenticated route and surfaces parsed insights, no re-auth', async () => {
    // --- establish + capture the live session in the SHARED browser ---
    const sharedOpen = await proxy.callTool(SHARED_BROWSER_SERVER_NAME, 'chrome-devtools-mcp__new_page', {
      url: targetUrl,
    });
    const sharedId = selectedPageId(sharedOpen);
    expect(sharedId).not.toBeNull();

    await proxy.callTool(SHARED_BROWSER_SERVER_NAME, 'chrome-devtools-mcp__evaluate_script', {
      pageId: sharedId,
      function: "() => window.__login('tok-PERF-123', 'sess-PERF-abc')",
    });
    const captured = evalJson(
      await proxy.callTool(SHARED_BROWSER_SERVER_NAME, 'chrome-devtools-mcp__evaluate_script', {
        pageId: sharedId,
        function: "() => ({ authToken: localStorage.getItem('authToken'), cookie: document.cookie })",
      }),
    ) as { authToken: string; cookie: string };
    expect(captured.authToken).toBe('tok-PERF-123');

    // --- seed the ISOLATED HEADLESS perf instance from the captured session ---
    const sessionVal = captured.cookie.match(/session=([^;]*)/)?.[1] ?? '';
    const seedScript =
      `localStorage.setItem('authToken', ${JSON.stringify(captured.authToken)});` +
      `document.cookie = 'session=' + ${JSON.stringify(sessionVal)} + '; path=/';`;

    const perfOpen = await proxy.callTool(PERF_SERVER_NAME, 'chrome-devtools-mcp-perf__new_page', {
      url: 'about:blank',
    });
    const perfId = selectedPageId(perfOpen);
    expect(perfId).not.toBeNull();

    await proxy.callTool(PERF_SERVER_NAME, 'chrome-devtools-mcp-perf__navigate_page', {
      pageId: perfId,
      type: 'url',
      url: targetUrl,
      initScript: seedScript,
    });

    // boots authenticated — no second login on the isolated instance
    const seededState = evalJson(
      await proxy.callTool(PERF_SERVER_NAME, 'chrome-devtools-mcp-perf__evaluate_script', {
        pageId: perfId,
        function: '() => window.__authState()',
      }),
    );
    expect(String(seededState)).toContain('AUTHENTICATED');
    expect(String(seededState)).toContain('tok-PERF-123');

    // --- record → dump: cold-load trace of the authenticated route ---
    // For a cold load (reload: true), start_trace records the reload and returns the
    // parsed insights directly; stop_trace then ends any still-open recording. Combine
    // both so the assertion holds regardless of which call carries the result.
    const started = await proxy.callTool(PERF_SERVER_NAME, 'chrome-devtools-mcp-perf__performance_start_trace', {
      pageId: perfId,
      reload: true,
    });
    const stopped = await proxy.callTool(PERF_SERVER_NAME, 'chrome-devtools-mcp-perf__performance_stop_trace', {
      pageId: perfId,
    });

    // parsed insights + Core Web Vitals come back as text
    const traceText = [textOf(started), textOf(stopped)].join('\n');
    expect(traceText).toMatch(/performance trace|insight/i);
    expect(traceText).toContain('LCP'); // Largest Contentful Paint captured
    expect(traceText).toContain('CLS'); // Cumulative Layout Shift captured

    // still authenticated after the traced reload — proves re-auth-free measurement
    const afterTrace = evalJson(
      await proxy.callTool(PERF_SERVER_NAME, 'chrome-devtools-mcp-perf__evaluate_script', {
        pageId: perfId,
        function: '() => window.__authState()',
      }),
    );
    expect(String(afterTrace)).toContain('AUTHENTICATED');
  }, 180000);
});
