import express from 'express';
import type { Express } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec, spawn } from 'child_process';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { homedir, tmpdir } from 'os';
import { promisify } from 'util';
import { createInterface } from 'readline';
import cors from 'cors';
import { createDiskSandbox, createLair } from '@minions/file-store';
import type { Directory } from '@minions/file-store';
import { readLairConfig } from '@minions/lair-config';
import { provisionLair } from '@minions/lair-provisioner';
import type { LairConfig } from '@minions/lair-config';
import { readLairsConfig, addLair } from './lairs-config.js';
import { findAvailablePort } from './utils/port.js';
import { mountDominionMCP } from './mcp/MCPServer.js';
import { startLairCabinet, stopLairCabinet, getLairProcess } from './lair-process.js';

const execAsync = promisify(exec);

// ── Agent process tracking ────────────────────────────────────────────────────

interface AgentRecord {
  status: 'running' | 'done' | 'error';
  exitCode: number | null;
  /** User-visible text lines extracted from the agent's stream-json output */
  textLines: string[];
}
const agentProcesses = new Map<string, AgentRecord>();

/**
 * Locate the Claude binary at the native installer's default path.
 * Does NOT fall back to PATH — relies on the known fixed install location.
 */
function findClaudePath(): string | null {
  const candidate = process.platform === 'win32'
    ? path.join(process.env['LOCALAPPDATA'] ?? '', 'AnthropicClaude', 'claude.exe')
    : path.join(homedir(), '.local', 'bin', 'claude');
  return existsSync(candidate) ? candidate : null;
}

/**
 * Extract a user-visible text string from one stream-json line.
 * Returns null for non-text lines (tool calls, system init, etc.).
 */
function extractText(line: string): string | null {
  try {
    const msg = JSON.parse(line) as Record<string, unknown>;
    if (msg['type'] === 'assistant') {
      const content = (msg['message'] as Record<string, unknown>)?.['content'];
      if (Array.isArray(content)) {
        const text = (content as Array<Record<string, unknown>>)
          .filter(b => b['type'] === 'text')
          .map(b => b['text'] as string)
          .join('');
        return text || null;
      }
    }
    if (msg['type'] === 'result' && msg['result']) {
      return `Result: ${msg['result']}`;
    }
  } catch {
    // Not JSON — surface raw non-empty lines (e.g. plain error text)
    if (line.trim()) return line;
  }
  return null;
}

/**
 * Build the setup.md file that the Claude agent reads.
 * Combines Dominion-supplied base context (lair root, tool docs, ordering rules)
 * with the project's configure-lair.md recipe.
 */
function buildSetupMd(lairRoot: string, recipe: string): string {
  return `\
# Lair Setup Instructions

## First: set the lair root in your bash session

Run this now, before anything else:

\`\`\`bash
export LAIR_ROOT="${lairRoot}"
echo "Lair root: $LAIR_ROOT"
\`\`\`

## Available MCP Tools

- **cabinet-lair** MCP server:
  - \`archives\` action — add/list/remove work and info archives
    - Add: \`{ action: "add", type: "work"|"info", name: "...", url: "..." }\`
  - \`costumes\` action — install/list costumes
    - Install: \`{ action: "install", wing: "...", costumePath: "...", installedName: "..." }\`
- **cabinet-conductor** MCP server:
  - \`wings\` action — create/delete/update wings
    - Create: \`{ action: "create", name: "...", workLocalRepo: "...", description: "..." }\`

## Ordering Rules

Complete these phases in this exact order — **do not start the next phase until the current one is fully done**:

1. **Archives** — add all archives (wings reference archive names, so archives must come first)
2. **Wings** — create all wings
3. **Extra steps** — run any project-specific setup described in the recipe
4. **Costumes** — install all costumes
5. **Lair MCP** — write the lair-level \`.mcp.json\` if specified

---

${recipe}
`;
}

// ── Server factory ────────────────────────────────────────────────────────────

export interface CreateDominionServerOptions {
  dominionRoot: string;
  port: number;
  /** Path to built frontend static files */
  frontendDir?: string;
}

export async function createDominionServer(options: CreateDominionServerOptions): Promise<Express> {
  const dominionDir = createDiskSandbox(options.dominionRoot).root;
  const app = express();

  app.use(cors({
    origin: process.env['NODE_ENV'] === 'development'
      ? 'http://localhost:5174'
      : false,
    exposedHeaders: ['mcp-session-id', 'mcp-protocol-version'],
    allowedHeaders: [
      'Content-Type',
      'Accept',
      'mcp-session-id',
      'mcp-protocol-version',
      'Last-Event-ID',
    ],
    credentials: true,
  }));

  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'dominion' });
  });

  // REST API: list lairs
  app.get('/api/lairs', async (_req, res) => {
    try {
      const config = await readLairsConfig(dominionDir);
      res.json(config.lairs);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // REST API: create a new lair entry (registers name + port; does not touch disk)
  app.post('/api/setup/create-lair', async (req, res) => {
    try {
      const { name, root } = req.body as { name: string; root?: string };
      if (!name) { res.status(400).json({ error: 'name is required' }); return; }
      const lairRoot = root ?? path.join(options.dominionRoot, name.replace(/[^a-zA-Z0-9_-]/g, '-'));
      const port = await findAvailablePort(3434);
      await addLair(dominionDir, { name, root: lairRoot, port });
      res.json({ ok: true, lairRoot, port });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // REST API: clone primary work archive into a lair (legacy — still used by old provisioning flow)
  app.post('/api/setup/add-primary-archive', async (req, res) => {
    try {
      const { lairRoot, url, token } = req.body as { lairRoot: string; url: string; token?: string };
      if (!lairRoot || !url) { res.status(400).json({ error: 'lairRoot and url are required' }); return; }
      const sandbox = createDiskSandbox(lairRoot);
      const lair = createLair(sandbox);
      const auth = token ? { token } : undefined;
      await lair.addWorkRepo('local', url, auth);
      res.json({ ok: true, archive: 'local', url });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // REST API: read and parse lair config from cloned work archive (legacy)
  app.post('/api/setup/read-config', async (req, res) => {
    try {
      const { lairRoot, url } = req.body as { lairRoot: string; url: string };
      if (!lairRoot || !url) { res.status(400).json({ error: 'lairRoot and url are required' }); return; }
      const gitDir = path.join(lairRoot, 'work', 'local.git');
      const readFile = async (filePath: string): Promise<string | null> => {
        try {
          const { stdout } = await execAsync(
            `git --git-dir="${gitDir}" show HEAD:${filePath}`,
            { encoding: 'utf-8' }
          );
          return stdout;
        } catch {
          return null;
        }
      };
      const result = await readLairConfig(readFile, url);
      res.json({ found: result.found, config: result.config });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // REST API: provision a lair (legacy SSE streaming progress)
  app.post('/api/setup/provision', async (req, res) => {
    const { lairRoot, url, config } = req.body as { lairRoot: string; url: string; config: LairConfig };
    if (!lairRoot || !url || !config) {
      res.status(400).json({ error: 'lairRoot, url, and config are required' });
      return;
    }

    const lairsConfig = await readLairsConfig(dominionDir);
    const entry = lairsConfig.lairs.find(l => l.root === lairRoot);
    const cabinetPort = entry?.port ?? 3434;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const send = (data: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      await provisionLair({
        lairRoot,
        config,
        cabinetPort,
        onProgress: (message) => send({ type: 'progress', message }),
      });
      send({ type: 'done' });
    } catch (err) {
      send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      res.end();
    }
  });

  // REST API: start Cabinet for a lair
  app.post('/api/lairs/start', async (req, res) => {
    try {
      const { lairRoot } = req.body as { lairRoot: string };
      if (!lairRoot) { res.status(400).json({ error: 'lairRoot is required' }); return; }
      const proc = await startLairCabinet(lairRoot);
      res.json({ ok: true, port: proc.port, pid: proc.pid });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // REST API: stop Cabinet for a lair
  app.post('/api/lairs/stop', (req, res) => {
    const { lairRoot } = req.body as { lairRoot: string };
    if (!lairRoot) { res.status(400).json({ error: 'lairRoot is required' }); return; }
    const stopped = stopLairCabinet(lairRoot);
    res.json({ ok: stopped });
  });

  // REST API: get Cabinet status for a lair
  app.post('/api/lairs/status', (req, res) => {
    const { lairRoot } = req.body as { lairRoot: string };
    if (!lairRoot) { res.status(400).json({ error: 'lairRoot is required' }); return; }
    const proc = getLairProcess(lairRoot);
    res.json({ running: !!proc, port: proc?.port ?? null, pid: proc?.pid ?? null });
  });

  // REST API: start Cabinet and optionally launch post-install mission (legacy)
  app.post('/api/setup/launch-mission', async (req, res) => {
    try {
      const { lairRoot, postInstallMission } = req.body as { lairRoot: string; postInstallMission?: string };
      if (!lairRoot) { res.status(400).json({ error: 'lairRoot is required' }); return; }

      const proc = await startLairCabinet(lairRoot);
      const cabinetUrl = `http://localhost:${proc.port}`;

      let ready = false;
      for (let i = 0; i < 30; i++) {
        try {
          if ((await fetch(cabinetUrl + '/health')).ok) { ready = true; break; }
        } catch { /* not ready yet */ }
        await new Promise<void>(resolve => setTimeout(resolve, 1000));
      }
      if (!ready) { res.status(500).json({ error: 'Cabinet did not become ready in time' }); return; }

      let missionStarted = false;
      if (postInstallMission) {
        try {
          const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
          const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
          const mcpClient = new Client({ name: 'dominion', version: '0.0.1' });
          const transport = new StreamableHTTPClientTransport(new URL(`${cabinetUrl}/mcp/conductor`));
          await mcpClient.connect(transport);
          try {
            await mcpClient.callTool({
              name: 'minions',
              arguments: { action: 'spawn', wingName: 'workshop-00', client: 'claude-code', agentPrompt: postInstallMission },
            });
            missionStarted = true;
          } finally {
            await mcpClient.close();
          }
        } catch (e) {
          console.warn('[dominion] Mission spawn failed:', e);
        }
      }

      res.json({ cabinetPort: proc.port, missionStarted });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── New recipe-based setup flow ─────────────────────────────────────────────

  /**
   * Fetch configure-lair.md from a dedicated config repository.
   * Clones just the config branch into a temp directory, reads the file, then
   * deletes the clone.  The config repo is independent of the work/local repo.
   */
  app.post('/api/setup/fetch-recipe', async (req, res) => {
    const { configUrl, configBranch = 'lair-default', token } = req.body as {
      configUrl: string;
      configBranch?: string;
      token?: string;
    };

    if (!configUrl) { res.status(400).json({ error: 'configUrl is required' }); return; }

    const branch = `meta/config/${configBranch}`;
    const tmpSandbox = createDiskSandbox(tmpdir());
    const cloneName = `lair-recipe-${randomUUID()}`;
    let clone: Awaited<ReturnType<typeof tmpSandbox.cloneReadOnly>> | undefined;

    try {
      clone = await tmpSandbox.cloneReadOnly(
        configUrl,
        tmpSandbox.root,
        cloneName,
        branch,
        token ? { token } : undefined
      );

      const recipeResult = await clone.child('configure-lair.md');
      if (!recipeResult.found || recipeResult.node.kind !== 'file') {
        res.json({ found: false, recipe: null, error: 'configure-lair.md not found in branch' });
        return;
      }

      const recipe = await recipeResult.node.read();
      res.json({ found: true, recipe });
    } catch (err) {
      res.json({ found: false, recipe: null, error: String(err) });
    } finally {
      if (clone) {
        try { await clone.delete(); } catch { /* ignore */ }
      }
    }
  });

  /**
   * Bootstrap the lair and launch a Claude agent to run the recipe (SSE).
   *
   * Bootstrap steps (synchronous, streamed to UI):
   *   1. Write cabinet.config.json (creates the lair root directory)
   *   2. Initialise private git repos (required for wing creation)
   *   3. Create admin directory with cabinet MCP config (.mcp.json)
   *   4. Write configure-lair.md + setup.md (base context + recipe) to admin
   *   5. Start Cabinet; wait for /health
   *   6. Spawn Claude agent with stream-json stdio (stdin/stdout/stderr all piped)
   *
   * The agent runs asynchronously.  Poll GET /api/setup/agent-status for results.
   */
  app.post('/api/setup/run-recipe', async (req, res) => {
    const { lairRoot, recipe } = req.body as { lairRoot: string; recipe: string };
    if (!lairRoot || !recipe) {
      res.status(400).json({ error: 'lairRoot and recipe are required' });
      return;
    }

    const lairsConfig = await readLairsConfig(dominionDir);
    const entry = lairsConfig.lairs.find(l => l.root === lairRoot);
    const cabinetPort = entry?.port ?? 3434;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const send = (data: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      // 1. Write cabinet.config.json (createFile() creates the lair root directory automatically)
      const sandbox = createDiskSandbox(lairRoot);
      const lair = createLair(sandbox);
      const cabinetConfigNode = await sandbox.root.child('cabinet.config.json');
      if (!cabinetConfigNode.found) {
        await sandbox.root.createFile('cabinet.config.json', JSON.stringify({ port: cabinetPort }, null, 2));
      }
      send({ type: 'progress', message: '✓ Lair directory ready, cabinet config written' });

      // 2. Initialise private repos (required before any wing can be created)
      send({ type: 'progress', message: 'Initialising private repositories…' });
      await lair.initPrivateRepo('local');
      await lair.initPrivateRepo('global');
      send({ type: 'progress', message: '✓ Private repositories initialised' });

      // 3. Create admin directory with cabinet MCP endpoints
      send({ type: 'progress', message: 'Creating admin directory…' });
      const base = `http://localhost:${cabinetPort}`;
      const adminMcp = {
        mcpServers: {
          'cabinet-lair':      { type: 'http', url: `${base}/mcp/lair` },
          'cabinet-conductor': { type: 'http', url: `${base}/mcp/conductor` },
        },
      };
      const adminResult = await sandbox.root.child('admin');
      const adminDir: Directory = (adminResult.found && adminResult.node.kind === 'directory')
        ? adminResult.node as Directory
        : await sandbox.root.createDirectory('admin');
      await adminDir.createFile('.mcp.json', JSON.stringify(adminMcp, null, 2));
      send({ type: 'progress', message: '✓ Admin directory configured' });

      // 4. Write recipe files to admin
      await adminDir.createFile('configure-lair.md', recipe);
      const setupMd = buildSetupMd(lairRoot, recipe);
      await adminDir.createFile('setup.md', setupMd);
      send({ type: 'progress', message: '✓ Setup instructions written to admin/setup.md' });

      // 5. Start Cabinet and wait for /health
      send({ type: 'progress', message: 'Starting Cabinet…' });
      const proc = await startLairCabinet(lairRoot);
      const cabinetUrl = `http://localhost:${proc.port}`;
      let ready = false;
      for (let i = 0; i < 30; i++) {
        try {
          if ((await fetch(cabinetUrl + '/health')).ok) { ready = true; break; }
        } catch { /* not ready yet */ }
        await new Promise<void>(resolve => setTimeout(resolve, 1000));
      }
      if (!ready) { send({ type: 'error', message: 'Cabinet did not become ready in 30 s' }); return; }
      send({ type: 'progress', message: '✓ Cabinet is ready' });

      // 6. Spawn Claude agent with all stdio piped (stream-json protocol)
      const claudePath = findClaudePath();
      if (!claudePath) {
        send({ type: 'error', message: 'Claude not found at the expected install location. Please ensure Claude Code is installed.' });
        return;
      }

      const adminPath = path.join(lairRoot, 'admin');
      const setupMdPath = path.join(adminPath, 'setup.md');
      // Keep the initial message short — long prompts can be ignored by the model.
      // All context lives in setup.md.
      const initialMessage = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: `Read ${setupMdPath} and follow all instructions in it.` },
      }) + '\n';

      const claudeProcess = spawn(
        claudePath,
        [
          '--input-format=stream-json',
          '--output-format=stream-json',
          '--verbose',
          '--dangerously-skip-permissions',
        ],
        { cwd: adminPath, stdio: ['pipe', 'pipe', 'pipe'] }
      );

      if (!claudeProcess.stdin) {
        throw new Error('claude process was spawned without a stdin pipe');
      }
      claudeProcess.stdin.write(initialMessage);
      claudeProcess.stdin.end();

      // Track agent output in memory
      const record: AgentRecord = { status: 'running', exitCode: null, textLines: [] };
      agentProcesses.set(lairRoot, record);
      const MAX_LINES = 400;

      const pushLine = (line: string) => {
        record.textLines.push(line);
        if (record.textLines.length > MAX_LINES) {
          record.textLines.splice(0, record.textLines.length - MAX_LINES);
        }
      };

      if (!claudeProcess.stdout || !claudeProcess.stderr) {
        throw new Error('claude process was spawned without stdout/stderr pipes');
      }

      const stdoutRl = createInterface({ input: claudeProcess.stdout, crlfDelay: Infinity });
      stdoutRl.on('line', (line) => {
        const text = extractText(line);
        if (text) pushLine(text);
      });

      const stderrRl = createInterface({ input: claudeProcess.stderr, crlfDelay: Infinity });
      stderrRl.on('line', (line) => {
        if (line.trim()) pushLine(`[stderr] ${line}`);
      });

      claudeProcess.on('exit', (code) => {
        record.status = code === 0 ? 'done' : 'error';
        record.exitCode = code;
      });

      send({ type: 'progress', message: '✓ Setup agent launched — running in background' });
      send({ type: 'done', cabinetPort: proc.port });
    } catch (err) {
      send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      res.end();
    }
  });

  /**
   * Poll the status of the Claude setup agent for a given lair.
   */
  app.get('/api/setup/agent-status', (req, res) => {
    const { lairRoot } = req.query as { lairRoot?: string };
    if (!lairRoot) { res.status(400).json({ error: 'lairRoot query param is required' }); return; }

    const record = agentProcesses.get(lairRoot);
    if (!record) {
      res.json({ found: false, running: false, done: false });
      return;
    }

    res.json({
      found: true,
      running: record.status === 'running',
      done: record.status !== 'running',
      success: record.status === 'done',
      exitCode: record.exitCode,
      log: record.textLines.join('\n'),
    });
  });

  // MCP endpoint
  mountDominionMCP(app, {
    dominionRoot: options.dominionRoot,
    getLairs: async () => {
      const config = await readLairsConfig(dominionDir);
      return config.lairs;
    },
  });

  // Serve Vue frontend in production
  const frontendDir = options.frontendDir
    ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend');
  app.use(express.static(frontendDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(frontendDir, 'index.html'));
  });

  return app;
}
