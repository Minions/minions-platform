import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Express } from 'express';
import { z } from 'zod';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createDiskSandbox, createLair } from '@minions/file-store';
import { readLairConfig } from '@minions/lair-config';
import type { LairConfig } from '@minions/lair-config';
import { provisionLair } from '@minions/lair-provisioner';
import type { LairEntry } from '../lairs-config.js';
import { addLair } from '../lairs-config.js';
import { findAvailablePort } from '../utils/port.js';
import {
  startLairCabinet,
  stopLairCabinet,
  getLairProcess,
} from '../lair-process.js';

const execAsync = promisify(exec);

export interface MCPServerOptions {
  dominionRoot: string;
  getLairs: () => Promise<LairEntry[]>;
}

export function mountDominionMCP(app: Express, options: MCPServerOptions): void {
  app.post('/mcp', async (req, res) => {
    const server = new McpServer({
      name: 'dominion',
      version: '0.0.1',
    });

    // ─── lairs_list ────────────────────────────────────────────────────────
    server.tool('lairs_list', 'List all known lairs', {}, async () => {
      const lairs = await options.getLairs();
      return { content: [{ type: 'text' as const, text: JSON.stringify(lairs) }] };
    });

    // ─── setup_create_lair ─────────────────────────────────────────────────
    server.tool(
      'setup_create_lair',
      'Create a new lair directory structure and register it in lairs.json',
      {
        name: z.string().describe('Human-readable name for the lair'),
        root: z.string().optional().describe('Absolute path for the lair root'),
      },
      async ({ name, root }) => {
        const lairRoot = root ?? path.join(
          options.dominionRoot, 'lairs',
          name.replace(/[^a-zA-Z0-9_-]/g, '-')
        );
        const port = await findAvailablePort(3434);
        const entry: LairEntry = { name, root: lairRoot, port };
        await addLair(createDiskSandbox(options.dominionRoot).root, entry);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, lairRoot, port }) }],
        };
      }
    );

    // ─── setup_add_primary_archive ─────────────────────────────────────────
    server.tool(
      'setup_add_primary_archive',
      'Clone the primary work repository into the lair as the "local" archive',
      {
        lairRoot: z.string(),
        url: z.string(),
        token: z.string().optional(),
      },
      async ({ lairRoot, url, token }) => {
        const sandbox = createDiskSandbox(lairRoot);
        const lair = createLair(sandbox);
        const auth = token ? { token } : undefined;
        await lair.addWorkRepo('local', url, auth);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, archive: 'local', url }) }],
        };
      }
    );

    // ─── setup_read_config ─────────────────────────────────────────────────
    server.tool(
      'setup_read_config',
      'Read and parse .minions-lair.config.md from the primary work archive',
      {
        lairRoot: z.string(),
        url: z.string().describe('Primary repo URL (used for defaults)'),
      },
      async ({ lairRoot, url }) => {
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
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ found: result.found, config: result.config }) }],
        };
      }
    );

    // ─── setup_provision ──────────────────────────────────────────────────
    server.tool(
      'setup_provision',
      'Provision a lair: clone archives, create wings, optionally start Cabinet',
      {
        lairRoot: z.string(),
        config: z.object({
          lairName: z.string(),
          planning: z.object({ repo: z.string(), branch: z.string(), path: z.string() }),
          workArchives: z.array(z.object({ name: z.string(), url: z.string(), branch: z.string().optional() })),
          infoArchives: z.array(z.object({ name: z.string(), url: z.string(), branch: z.string().optional() })),
          postInstallMission: z.string().nullable(),
        }),
        anthropicApiKey: z.string().optional(),
        startCabinet: z.boolean().optional().default(false),
      },
      async ({ lairRoot, config, anthropicApiKey, startCabinet }) => {
        const progress: string[] = [];
        const lairConfig: LairConfig = config;

        // Find available Cabinet port
        const cabinetPort = await findAvailablePort(3434);

        const result = await provisionLair({
          lairRoot,
          config: lairConfig,
          cabinetPort,
          anthropicApiKey,
          onProgress: (msg) => { progress.push(msg); },
        });

        let cabinetStarted = false;
        if (startCabinet) {
          try {
            await startLairCabinet(lairRoot);
            cabinetStarted = true;
            progress.push('✓ Cabinet process started');
          } catch (err) {
            progress.push(`Cabinet start failed: ${String(err)}`);
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ ok: true, ...result, cabinetStarted, progress }),
          }],
        };
      }
    );

    // ─── lairs_start ──────────────────────────────────────────────────────
    server.tool(
      'lairs_start',
      'Start the Cabinet process for a lair',
      { lairRoot: z.string() },
      async ({ lairRoot }) => {
        const proc = await startLairCabinet(lairRoot);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, port: proc.port, pid: proc.pid }) }],
        };
      }
    );

    // ─── lairs_stop ───────────────────────────────────────────────────────
    server.tool(
      'lairs_stop',
      'Stop the Cabinet process for a lair',
      { lairRoot: z.string() },
      async ({ lairRoot }) => {
        const stopped = stopLairCabinet(lairRoot);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: stopped }) }],
        };
      }
    );

    // ─── lairs_status ─────────────────────────────────────────────────────
    server.tool(
      'lairs_status',
      'Check if the Cabinet is running for a lair',
      { lairRoot: z.string() },
      async ({ lairRoot }) => {
        const proc = getLairProcess(lairRoot);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ running: !!proc, port: proc?.port ?? null, pid: proc?.pid ?? null }),
          }],
        };
      }
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body as Record<string, unknown>);
  });

  app.get('/mcp', async (_req, res) => {
    res.status(405).json({ error: 'Method Not Allowed' });
  });

  app.delete('/mcp', async (_req, res) => {
    res.status(405).json({ error: 'Method Not Allowed' });
  });
}
