import { createDiskSandbox, createLair, generateWingClaudeMd } from '@minions/file-store';
import type { Sandbox, Wing, File, Directory } from '@minions/file-store';
import type { LairConfig } from '@minions/lair-config';

export type ProgressCallback = (message: string) => void;

export interface ProvisionOptions {
  lairRoot: string;
  config: LairConfig;
  /** Cabinet port to write into .mcp.json of each wing */
  cabinetPort: number;
  /** If set, written to {lairRoot}/.env as ANTHROPIC_API_KEY */
  anthropicApiKey?: string;
  onProgress?: ProgressCallback;
}

export interface ProvisionResult {
  lairName: string;
  wingsCreated: string[];
  archivesCloned: string[];
}

/** Wing names to create for each new lair */
export const STANDARD_WINGS = ['planning', 'workshop-00', 'workshop-01', 'workshop-02', 'workshop-03', 'workshop-04'];

export async function provisionLair(options: ProvisionOptions): Promise<ProvisionResult> {
  const { lairRoot, config, cabinetPort, onProgress } = options;
  const progress = (msg: string) => { onProgress?.(msg); };

  const sandbox = createDiskSandbox(lairRoot);
  const lair = createLair(sandbox);

  const archivesCloned: string[] = [];
  const wingsCreated: string[] = [];

  // Step 1: Clone additional work archives (beyond 'local' which is already cloned)
  for (const archive of config.workArchives) {
    if (archive.name === 'local') continue;
    progress(`Cloning work archive: ${archive.name}`);
    await lair.addWorkRepo(archive.name, archive.url);
    archivesCloned.push(archive.name);
    progress(`✓ Work archive '${archive.name}' cloned`);
  }

  // Step 2: Clone info archives
  for (const archive of config.infoArchives) {
    progress(`Cloning info archive: ${archive.name}`);
    await lair.addInfoRepo(archive.name, archive.url, undefined, archive.branch);
    archivesCloned.push(archive.name);
    progress(`✓ Info archive '${archive.name}' cloned`);
  }

  // Step 3: Initialize private repos (required for wings)
  progress('Initializing private repositories...');
  await lair.initPrivateRepo('local');
  await lair.initPrivateRepo('global');
  progress('✓ Private repositories initialized');

  // Step 4: Create standard wings
  const lairName = config.lairName;
  for (const wingName of STANDARD_WINGS) {
    progress(`Creating wing: ${wingName}`);
    const branchBase = `l/${lairName}/w/${wingName}`;

    const wing = await lair.createWing(wingName, {
      workLocal: { repo: 'local', branch: branchBase },
      privateLocal: { branch: `${branchBase}/local` },
      privateGlobal: { branch: `${branchBase}/global` },
      infoLink: config.infoArchives.length > 0,
      closetLink: true,
    });

    // Write CLAUDE.md
    const claudeMdContent = generateWingClaudeMd({ wingName, lairName });
    const claudeMdFile = await wing.claudeMd();
    await claudeMdFile.write(claudeMdContent);

    // Write .mcp.json so Claude Code knows about the Cabinet
    await writeMcpSettings(wing, cabinetPort);

    wingsCreated.push(wingName);
    progress(`✓ Wing '${wingName}' created`);
  }

  // Step 5: Create admin directory with lair MCP config
  progress('Creating admin directory...');
  await writeAdminMcpSettings(sandbox, cabinetPort);
  progress('✓ Admin directory created');

  // Step 6: Write .env with ANTHROPIC_API_KEY if provided
  if (options.anthropicApiKey) {
    progress('Writing .env file...');
    await writeEnvFile(sandbox, options.anthropicApiKey);
    progress('✓ .env file written');
  }

  return { lairName, wingsCreated, archivesCloned };
}

async function writeMcpSettings(wing: Wing, cabinetPort: number): Promise<void> {
  const settings = {
    mcpServers: {
      cabinet: {
        type: 'http',
        url: `http://localhost:${cabinetPort}/mcp/henchery`,
      },
    },
  };
  const content = JSON.stringify(settings, null, 2);

  const existing = await wing.root.child('.mcp.json');
  if (existing.found && existing.node.is('file')) {
    await (existing.node as File).write(content);
  } else {
    await wing.root.createFile('.mcp.json', content);
  }
}

async function writeAdminMcpSettings(sandbox: Sandbox, cabinetPort: number): Promise<void> {
  const base = `http://localhost:${cabinetPort}`;
  const settings = {
    mcpServers: {
      // Lair-config tools: archives
      'cabinet-lair': {
        type: 'http',
        url: `${base}/mcp/lair`,
      },
      // Wing/minion/mission orchestration tools: wings, minions, missions
      'cabinet-conductor': {
        type: 'http',
        url: `${base}/mcp/conductor`,
      },
    },
  };
  const content = JSON.stringify(settings, null, 2);

  const existing = await sandbox.root.child('admin');
  const adminDir = (existing.found && existing.node.kind === 'directory')
    ? (existing.node as Directory)
    : await sandbox.root.createDirectory('admin');
  await adminDir.createFile('.mcp.json', content);
}

async function writeEnvFile(sandbox: Sandbox, anthropicApiKey: string): Promise<void> {
  await sandbox.root.createFile('.env', `ANTHROPIC_API_KEY=${anthropicApiKey}\n`);
}
