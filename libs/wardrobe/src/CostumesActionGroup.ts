/**
 * CostumesActionGroup — MCP action group for managing wing costume accessories.
 *
 * Core actions:
 *   list   — list all installed costumes from the closet
 *   status — show a wing's active costumes, available costumes, and junction state
 *   change — update a wing's accessories.json and sync
 *
 * Secondary actions:
 *   install                 — install a built costume to the lair closet
 *   debug-install           — install a costume from source for development
 *   install-from-marketplace — install a Claude Code marketplace plugin as a costume
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Directory, Wing } from '@minions/file-store';
import type { ActionGroupDef } from '@minions/mcp-types';
import {
  listInstalledCostumes,
  installCostume,
  debugInstallCostume,
  installMarketplaceCostume,
} from '@minions/costumes';
import type { AccessoriesConfig } from './AccessoriesConfig.js';
import { isAccessoriesConfig } from './AccessoriesConfig.js';
import { readAccessoriesFile, writeAccessoriesFile } from './AccessoriesFile.js';
import { syncWardrobe } from './WardrobeSync.js';

// Structural type matching ActionContext from mcp-types, with optional service fields
// for the install/publish actions (provided by the cabinet dispatcher).
interface ActionContext {
  lair: { root: Directory };
  /** Wing name injected from URL path /mcp/henchery/:wingName — undefined on non-henchery endpoints. */
  wingName?: string;
  /** Absolute path to the lair root directory (for install-from-marketplace, publish). */
  lairRootPath?: string;
  /** Look up a wing by name (for debug-install, publish). */
  getWing?: (name: string) => Wing | undefined;
  /** Called after a costume is installed to invalidate cached mission lists.
   *  Pass wingName to invalidate that wing only; omit to invalidate all. */
  onCostumeInstalled?: (wingName?: string) => void;
  /** Named registries available for costume install/publish (injected by cabinet). */
  registries?: Record<string, { indexBaseUrl: string; publishApi?: string; publishDirect?: { indexRepo: string }; auth?: unknown }>;
  /** Default registry name to use when none is specified. */
  defaultRegistry?: string;
  /** Install a costume from a registry (injected by cabinet). */
  installFromRegistry?: (
    name: string,
    version: string,
    registry: { indexBaseUrl: string; publishApi?: string; publishDirect?: { indexRepo: string }; auth?: unknown }
  ) => Promise<{ message: string; closetPath: string; commandsPath?: string; agentsPath?: string; skillsPath?: string }>;
  /** Publish a costume to a registry (injected by cabinet). */
  publishCostume?: (
    name: string,
    version: string,
    registry: { indexBaseUrl: string; publishApi?: string; publishDirect?: { indexRepo: string }; auth?: unknown },
    distDir: string,
    dryRun?: boolean
  ) => Promise<{ message: string; archiveUrl: string; digest: string; version: string }>;
  [key: string]: unknown;
}

/** Resolve the lair root Directory from the action context. */
function getLairRoot(ctx: ActionContext): Directory {
  return ctx.lair.root as Directory;
}

/**
 * Navigate to [lair-root]/wings/[wingName]/ and return it.
 * Returns null if the wing directory does not exist.
 */
async function getWingRoot(lairRoot: Directory, wingName: string): Promise<Directory | null> {
  const wingsResult = await lairRoot.child('wings');
  if (!wingsResult.found || wingsResult.node.kind !== 'directory') return null;
  const wingsDir = wingsResult.node as Directory;
  const wingResult = await wingsDir.child(wingName);
  if (!wingResult.found || wingResult.node.kind !== 'directory') return null;
  return wingResult.node as Directory;
}

/**
 * Navigate to [wing-root]/work/local/ and return it.
 * Returns null if it does not exist.
 */
async function getWorkLocalRoot(wingRoot: Directory): Promise<Directory | null> {
  const workResult = await wingRoot.child('work');
  if (!workResult.found || workResult.node.kind !== 'directory') return null;
  const localResult = await (workResult.node as Directory).child('local');
  if (!localResult.found || localResult.node.kind !== 'directory') return null;
  return localResult.node as Directory;
}

/**
 * Resolve the wing name from params, falling back to the session context wing.
 * Throws if neither is available.
 */
function resolveWingName(ctx: ActionContext, params: Record<string, unknown>): string {
  const wingName = (params['wing'] as string | undefined) ?? ctx.wingName;
  if (!wingName) {
    throw new Error('wing is required: no wing param and no wing in session context');
  }
  return wingName;
}

// ---- action: list ----

const listAction = {
  description: 'list all installed costumes from the lair closet',
  help: `**costumes list** — List all installed costumes in the lair's closet.

Shows each costume's name, installation type, and contents (missions, disguises, skills).
No wing required — reads from the shared lair closet.

Returns: { action: 'list', costumes: InstalledCostumeSummary[] }`,
  params: {} as Record<string, never>,
  required: [] as string[],
  async execute(ctx: ActionContext, _params: Record<string, unknown>) {
    const lairRoot = getLairRoot(ctx);
    const costumes = await listInstalledCostumes(lairRoot);
    return { action: 'list', costumes };
  },
};

// ---- action: status ----

const statusAction = {
  description: 'show a wing\'s active costumes, available costumes, and junction state',
  help: `**costumes status** — Show the accessory status for a wing.

Reads the wing's accessories.json and the lair's closet to report:
- Active costumes (listed in accessories.json)
- Available costumes not currently active
- Whether each active costume's missions junction exists

Optional: wing (defaults to the session's own wing; specify to check a foreign wing)
Returns: { action: 'status', wing, activeCostumes, availableCostumes, junctions }`,
  params: {
    wing: {
      type: 'string' as const,
      description: 'Name of the wing to check (defaults to the session\'s own wing)',
    },
  },
  required: [] as string[],
  async execute(ctx: ActionContext, params: Record<string, unknown>) {
    const wingName = resolveWingName(ctx, params);
    const lairRoot = getLairRoot(ctx);
    const wingRoot = await getWingRoot(lairRoot, wingName);

    // Read accessories config
    const config: AccessoriesConfig | null = wingRoot
      ? await readAccessoriesFile(wingRoot)
      : null;
    const activeCostumes = config?.costumes ?? [];

    // Read all available costumes from closet
    const allCostumes = await listInstalledCostumes(lairRoot);
    const allNames = allCostumes.map((c) => c.name);
    const availableCostumes = allNames.filter((n) => !activeCostumes.includes(n));

    // Check junction state
    const junctions: Record<string, boolean> = {};
    if (wingRoot) {
      const claudeResult = await wingRoot.child('.claude');
      if (claudeResult.found && claudeResult.node.kind === 'directory') {
        const cmdResult = await (claudeResult.node as Directory).child('commands');
        if (cmdResult.found && cmdResult.node.kind === 'directory') {
          const children = await (cmdResult.node as Directory).children();
          for (const child of children) {
            if (child.kind === 'junction') {
              junctions[child.name] = true;
            }
          }
        }
      }
    }

    return {
      action: 'status',
      wing: wingName,
      activeCostumes,
      availableCostumes,
      junctions,
      permissions: config?.permissions ?? null,
    };
  },
};

// ---- action: sync-all ----

function makeSyncAllAction(port: number) {
  return {
    description: 'sync all wings to their current accessories.json (re-writes .mcp.json, missions junctions, and permissions)',
    help: `**costumes sync-all** — Re-sync every wing in the lair.

For each wing found in [lair-root]/wings/:
  - Reads the wing's .meta/accessories.json (defaults to {costumes:[]} if absent)
  - Re-runs full wardrobe sync: .mcp.json, .claude/commands/ junctions, settings.json permissions

Useful after a cabinet update or port change. No parameters required.
Returns: { action: 'sync-all', results: Array<{ wing, status, error? }> }`,
    params: {} as Record<string, never>,
    required: [] as string[],
    async execute(ctx: ActionContext, _params: Record<string, unknown>) {
      const lairRoot = getLairRoot(ctx);

      // List all wing directories
      const wingsResult = await lairRoot.child('wings');
      if (!wingsResult.found || wingsResult.node.kind !== 'directory') {
        return { action: 'sync-all', results: [] };
      }
      const wingsDir = wingsResult.node as Directory;
      const children = await wingsDir.children();
      const wingDirs = children.filter(
        (c) => c.kind === 'directory' || c.kind === 'junction'
      ) as Directory[];

      const results: Array<{ wing: string; status: 'synced' | 'error'; error?: string }> = [];

      for (const wingDir of wingDirs) {
        const wingName = wingDir.name;
        try {
          const wingRoot = wingDir as Directory;
          const workLocalRoot = (await getWorkLocalRoot(wingRoot)) ?? wingRoot;
          const config = (await readAccessoriesFile(wingRoot)) ?? { costumes: [] };

          // write accessories.json only if absent (don't overwrite existing config)
          await writeAccessoriesFile(wingRoot, config);
          await syncWardrobe(wingRoot, workLocalRoot, lairRoot, wingName, config, port);

          results.push({ wing: wingName, status: 'synced' });
        } catch (err) {
          results.push({ wing: wingName, status: 'error', error: (err as Error).message });
        }
      }

      return { action: 'sync-all', results };
    },
  };
}

// ---- secondary action: install ----

const installAction = {
  description: 'install a built costume to the lair closet by linking to its dist/ directory',
  help: `**costumes install** — Install a built costume to the lair closet.

Links the costume's dist/ directory into the lair's closet and sets up the wing's
.claude/commands/, .claude/agents/, and .claude/skills/ junctions as applicable.
The costume must be built first.

Required: wing, costumePath, installedName
Returns: { action: 'install', message, closetLink, commandsLink?, agentsLink?, skillsLink? }`,
  params: {
    wing: {
      type: 'string' as const,
      description: 'Name of the wing containing the costume source',
    },
    costumePath: {
      type: 'string' as const,
      description: 'Path to the costume within work/local (e.g., "costumes/my-costume")',
    },
    installedName: {
      type: 'string' as const,
      description: 'Name to install the costume as in the closet',
    },
  },
  required: ['wing', 'costumePath', 'installedName'] as string[],
  async execute(ctx: ActionContext, params: Record<string, unknown>) {
    const wingName = resolveWingName(ctx, params);
    const lairRoot = getLairRoot(ctx);

    const result = await installCostume(
      lairRoot,
      wingName,
      params['costumePath'] as string,
      params['installedName'] as string
    );

    ctx.onCostumeInstalled?.();

    return {
      action: 'install',
      message: result.message,
      closetLink: result.closetLink.path,
      commandsLink: result.commandsLink?.path,
      agentsLink: result.agentsLink?.path,
      skillsLink: result.skillsLink?.path,
    };
  },
};

// ---- secondary action: debug-install ----

const debugInstallAction = {
  description: 'install a costume from source for development (links to src/ instead of dist/)',
  help: `**costumes debug-install** — Debug-install a costume from source.

Creates symlinks from a target wing's closet to the costume's src/ directory,
enabling live reloading during development. The source is in the source wing's
work/local; the costume is installed into the target wing's closet.

Required: wing (source), costumePath, installedName, targetWing
Returns: { action: 'debug-install', message, closetLink, commandsLink?, agentsLink?, skillsLink? }`,
  params: {
    wing: {
      type: 'string' as const,
      description: 'Name of the wing containing the costume source',
    },
    costumePath: {
      type: 'string' as const,
      description: 'Path to the costume within work/local (e.g., "costumes/my-costume")',
    },
    installedName: {
      type: 'string' as const,
      description: 'Name to install the costume as in the closet',
    },
    targetWing: {
      type: 'string' as const,
      description: 'Name of the wing to install the costume into',
    },
  },
  required: ['wing', 'costumePath', 'installedName', 'targetWing'] as string[],
  async execute(ctx: ActionContext, params: Record<string, unknown>) {
    const wingName = resolveWingName(ctx, params);
    const targetWingName = params['targetWing'] as string;
    const lairRoot = getLairRoot(ctx);

    if (!ctx.getWing) {
      throw new Error('debug-install requires wing manager (not available in this context)');
    }
    const targetWing = ctx.getWing(targetWingName);
    if (!targetWing) {
      throw new Error(`Target wing not found: ${targetWingName}`);
    }

    const result = await debugInstallCostume(
      lairRoot,
      wingName,
      params['costumePath'] as string,
      params['installedName'] as string,
      targetWing
    );

    ctx.onCostumeInstalled?.(targetWingName);

    return {
      action: 'debug-install',
      message: result.message,
      closetLink: result.closetLink.path,
      commandsLink: result.commandsLink?.path,
      agentsLink: result.agentsLink?.path,
      skillsLink: result.skillsLink?.path,
    };
  },
};

// ---- secondary action: install-from-marketplace ----

/**
 * Locate a Claude Code marketplace plugin on disk.
 * Resolution order:
 * 1. ~/.claude/plugins/installed_plugins.json (previously installed via /plugin)
 * 2. ~/.claude/plugins/marketplaces/{marketplace}/plugins/{plugin}/ (marketplace clone)
 * 3. ~/.claude/plugins/cache/{marketplace}/{plugin}/ (cached download, latest version)
 */
async function findOrLocatePlugin(pluginName: string, marketplace: string): Promise<string> {
  const { homedir } = await import('node:os');
  const home = homedir();

  const registryPath = join(home, '.claude', 'plugins', 'installed_plugins.json');
  try {
    const content = await readFile(registryPath, 'utf-8');
    const registry = JSON.parse(content) as {
      version?: number;
      plugins?: Record<string, Array<{ installPath: string }>>;
    };
    const key = `${pluginName}@${marketplace}`;
    const entries = registry.plugins?.[key];
    if (entries && entries.length > 0) {
      return entries[0].installPath;
    }
  } catch {
    // Registry missing or unreadable — continue
  }

  const marketplacePluginPath = join(
    home, '.claude', 'plugins', 'marketplaces', marketplace, 'plugins', pluginName
  );
  try {
    await readdir(marketplacePluginPath);
    return marketplacePluginPath;
  } catch {
    // Not in marketplace clone
  }

  const cachePath = join(home, '.claude', 'plugins', 'cache', marketplace, pluginName);
  try {
    const versions = await readdir(cachePath);
    if (versions.length > 0) {
      versions.sort();
      return join(cachePath, versions[versions.length - 1]);
    }
  } catch {
    // Cache not found
  }

  throw new Error(
    `Plugin "${pluginName}" not found for marketplace "${marketplace}". ` +
    `Add the marketplace first (/marketplace add), or cache the plugin (/plugin install ${pluginName}).`
  );
}

async function enablePluginInSettings(settingsPath: string, pluginKey: string): Promise<void> {
  await mkdir(dirname(settingsPath), { recursive: true });

  let settings: { enabledPlugins?: Record<string, boolean>; [key: string]: unknown } = {};
  try {
    const content = await readFile(settingsPath, 'utf-8');
    settings = JSON.parse(content) as typeof settings;
  } catch {
    // File doesn't exist or isn't valid JSON — start fresh
  }

  if (!settings.enabledPlugins) {
    settings.enabledPlugins = {};
  }
  if (!settings.enabledPlugins[pluginKey]) {
    settings.enabledPlugins[pluginKey] = true;
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  }
}

async function propagatePluginToWings(lairRoot: string, pluginKey: string): Promise<void> {
  const wingsDir = join(lairRoot, 'wings');
  let wingNames: string[];
  try {
    wingNames = await readdir(wingsDir);
  } catch {
    return;
  }
  await Promise.all(
    wingNames.map(async (wingName) => {
      const settingsPath = join(wingsDir, wingName, 'work', 'local', '.claude', 'settings.json');
      try {
        await enablePluginInSettings(settingsPath, pluginKey);
      } catch {
        // Wing may not have work/local yet — skip silently
      }
    })
  );
}

const installFromMarketplaceAction = {
  description: 'install a Claude Code marketplace plugin as a costume',
  help: `**costumes install-from-marketplace** — Install a marketplace plugin as a costume.

Locates the plugin on disk (from installed registry, marketplace clone, or download cache),
installs it into the lair closet, and writes enabledPlugins to .claude/settings.json for
the lair and all existing wings.

Required: pluginName
Optional: marketplace (default: "claude-plugins-official"), installedName (default: pluginName)
Returns: { action: 'install-from-marketplace', message, closetPath, commandsPath?, agentsPath?, skillsPath? }`,
  params: {
    pluginName: {
      type: 'string' as const,
      description: 'Plugin name from the marketplace (e.g. "frontend-design")',
    },
    marketplace: {
      type: 'string' as const,
      description: 'Marketplace identifier. Defaults to "claude-plugins-official"',
    },
    installedName: {
      type: 'string' as const,
      description: 'Name to register the costume as. Defaults to pluginName',
    },
  },
  required: ['pluginName'] as string[],
  async execute(ctx: ActionContext, params: Record<string, unknown>) {
    if (!ctx.lairRootPath) {
      throw new Error('install-from-marketplace requires lairRootPath in context');
    }
    const lairRoot = getLairRoot(ctx);

    const pluginName = params['pluginName'] as string;
    const resolvedMarketplace = (params['marketplace'] as string | undefined) ?? 'claude-plugins-official';
    const resolvedInstalledName = (params['installedName'] as string | undefined) ?? pluginName;

    const pluginSourcePath = await findOrLocatePlugin(pluginName, resolvedMarketplace);

    const result = await installMarketplaceCostume(lairRoot, resolvedInstalledName, pluginSourcePath);

    const pluginKey = `${pluginName}@${resolvedMarketplace}`;
    const lairSettingsPath = join(ctx.lairRootPath as string, '.claude', 'settings.json');
    await enablePluginInSettings(lairSettingsPath, pluginKey);
    await propagatePluginToWings(ctx.lairRootPath as string, pluginKey);

    ctx.onCostumeInstalled?.();

    return {
      action: 'install-from-marketplace',
      message: result.message,
      closetPath: result.closetPath,
      commandsPath: result.commandsPath,
      agentsPath: result.agentsPath,
      skillsPath: result.skillsPath,
    };
  },
};

// ---- secondary action: install-from-registry ----

const installFromRegistryAction = {
  description: 'install a costume from a registry (GitHub-hosted package repo)',
  help: `**costumes install-from-registry** — Install a costume from a hosted registry.

Downloads the archive from a GitHub-based registry, verifies its SHA-256 digest,
extracts it to the lair closet, and creates .claude/ links for missions, briefings,
and skills. Registry configuration comes from cabinet.config.json.

Required: name, version
Optional: registry (name of registry in cabinet.config.json; defaults to defaultRegistry)
Optional: registryUrl (one-off index base URL, overrides named registry lookup)
Returns: { action: 'install-from-registry', message, closetPath, commandsPath?, agentsPath?, skillsPath? }`,
  params: {
    name: {
      type: 'string' as const,
      description: 'Costume name (e.g. "dev-and-check")',
    },
    version: {
      type: 'string' as const,
      description: 'Version to install (e.g. "0.1.0")',
    },
    registry: {
      type: 'string' as const,
      description: 'Registry name from cabinet.config.json (defaults to defaultRegistry)',
    },
    registryUrl: {
      type: 'string' as const,
      description: 'One-off registry index base URL (e.g. "https://raw.githubusercontent.com/owner/repo/main"). Overrides the named registry lookup — no pre-configuration required.',
    },
  },
  required: ['name', 'version'] as string[],
  async execute(ctx: ActionContext, params: Record<string, unknown>) {
    if (!ctx.installFromRegistry) {
      throw new Error('install-from-registry is not available in this context (requires cabinet with registry config)');
    }

    const name = params['name'] as string;
    const version = params['version'] as string;
    const registryUrl = params['registryUrl'] as string | undefined;

    let registryConfig: { indexBaseUrl: string; publishApi?: string; publishDirect?: { indexRepo: string }; auth?: unknown };
    let registryLabel: string;

    if (registryUrl) {
      // One-off URL install — build an inline config with no auth
      registryConfig = { indexBaseUrl: registryUrl };
      registryLabel = registryUrl;
    } else {
      const registryName = (params['registry'] as string | undefined) ?? ctx.defaultRegistry ?? 'official';
      const registries = ctx.registries ?? {};
      const found = registries[registryName];
      if (!found) {
        const available = Object.keys(registries).join(', ') || '(none configured)';
        throw new Error(
          `Registry "${registryName}" not found in cabinet.config.json. Available: ${available}. ` +
          'Use registryUrl for a one-off install without pre-configuration.'
        );
      }
      registryConfig = found;
      registryLabel = registryName;
    }

    const result = await ctx.installFromRegistry(name, version, registryConfig);

    ctx.onCostumeInstalled?.();

    return {
      action: 'install-from-registry',
      registry: registryLabel,
      message: result.message,
      closetPath: result.closetPath,
      commandsPath: result.commandsPath,
      agentsPath: result.agentsPath,
      skillsPath: result.skillsPath,
    };
  },
};

// ---- secondary action: publish ----

const publishAction = {
  description: 'publish a built costume to a registry',
  help: `**costumes publish** — Publish a built costume to a hosted registry.

Creates a tar.gz archive from the costume's dist/ directory, uploads it to the registry's
archive store (GitHub Releases for direct, R2 for Worker), and updates the index file.

The registry must be configured in cabinet.config.json with either publishApi or publishDirect.
A GitHub token must be stored (via registry auth connect or GITHUB_TOKEN env var).

Required: name, version, wing
Optional: registry (name from config; defaults to defaultRegistry), costumePath (relative to wing's work/local, defaults to "costumes/{name}"), dryRun
Returns: { action: 'publish', message, archiveUrl, digest, version }`,
  params: {
    name: {
      type: 'string' as const,
      description: 'Costume package name (e.g. "dev-and-check")',
    },
    version: {
      type: 'string' as const,
      description: 'Version to publish (e.g. "0.1.0" or "0.2.0-pre")',
    },
    wing: {
      type: 'string' as const,
      description: 'Wing containing the built costume source',
    },
    registry: {
      type: 'string' as const,
      description: 'Registry name from cabinet.config.json (defaults to defaultRegistry)',
    },
    costumePath: {
      type: 'string' as const,
      description: 'Path to the costume within wing\'s work/local (defaults to "costumes/{name}")',
    },
    dryRun: {
      type: 'boolean' as const,
      description: 'Print what would happen without uploading (default: false)',
    },
  },
  required: ['name', 'version', 'wing'] as string[],
  async execute(ctx: ActionContext, params: Record<string, unknown>) {
    if (!ctx.publishCostume) {
      throw new Error('publish is not available in this context (requires cabinet with registry and GitHub auth)');
    }
    if (!ctx.lairRootPath) {
      throw new Error('publish requires lairRootPath in context');
    }

    const name = params['name'] as string;
    const version = params['version'] as string;
    const wingName = resolveWingName(ctx, params);
    const dryRun = (params['dryRun'] as boolean | undefined) ?? false;
    const registryName = (params['registry'] as string | undefined) ?? ctx.defaultRegistry ?? 'official';
    const costumeRelPath = (params['costumePath'] as string | undefined) ?? `costumes/${name}`;

    const registries = ctx.registries ?? {};
    const registryConfig = registries[registryName];
    if (!registryConfig) {
      const available = Object.keys(registries).join(', ') || '(none configured)';
      throw new Error(`Registry "${registryName}" not found in cabinet.config.json. Available: ${available}`);
    }

    // Resolve dist directory from the wing
    const { join } = await import('node:path');
    const distDir = join(ctx.lairRootPath as string, 'wings', wingName, 'work', 'local', costumeRelPath, 'dist');

    const result = await ctx.publishCostume(name, version, registryConfig, distDir, dryRun);

    return {
      action: 'publish',
      registry: registryName,
      message: result.message,
      archiveUrl: result.archiveUrl,
      digest: result.digest,
      version: result.version,
    };
  },
};

// ---- factory ----

function makeChangeAction(port: number) {
  return {
    description: 'update a wing\'s accessories.json and sync',
    help: `**costumes change** — Update a wing's accessories configuration and sync.

Parses and validates the new config JSON, writes accessories.json, then runs
syncWardrobe to update .claude/commands/ junctions, .mcp.json, and settings.json.

Optional: wing (defaults to the session's own wing; specify to change a foreign wing)
Required: to (JSON string of AccessoriesConfig)
Returns: { action: 'change', wing, config }`,
    params: {
      wing: {
        type: 'string' as const,
        description: 'Name of the wing to update (defaults to the session\'s own wing)',
      },
      to: {
        type: 'string' as const,
        description: 'New AccessoriesConfig as a JSON string',
      },
    },
    required: ['to'] as string[],
    async execute(ctx: ActionContext, params: Record<string, unknown>) {
      const wingName = resolveWingName(ctx, params);
      const toStr = params['to'] as string;

      // Parse and validate config
      let parsed: unknown;
      try {
        parsed = JSON.parse(toStr);
      } catch (err) {
        throw new Error(`Invalid JSON in 'to' parameter: ${(err as Error).message}`);
      }

      if (!isAccessoriesConfig(parsed)) {
        throw new Error(
          'Invalid accessories config: must be { costumes: string[], permissions?: { allow?: string[], deny?: string[] } }'
        );
      }

      const config: AccessoriesConfig = parsed;
      const lairRoot = getLairRoot(ctx);

      // Ensure wing exists
      const wingRoot = await getWingRoot(lairRoot, wingName);
      if (!wingRoot) {
        throw new Error(`Wing not found: ${wingName}`);
      }

      // Write accessories.json
      await writeAccessoriesFile(wingRoot, config);

      // Resolve work/local (may not exist in all environments — fall back to wing root)
      const workLocalRoot = (await getWorkLocalRoot(wingRoot)) ?? wingRoot;

      // syncWardrobe handles the rest, using the port captured in the closure
      await syncWardrobe(wingRoot, workLocalRoot, lairRoot, wingName, config, port);

      return {
        action: 'change',
        wing: wingName,
        config,
      };
    },
  };
}

/**
 * Create the `costumes` ActionGroupDef.
 *
 * @param port - The cabinet's port number (used by syncMcpJson when syncing a wing)
 */
export function createCostumesActionGroup(port: number): ActionGroupDef {
  return {
    name: 'costumes',
    description:
      'Manage wing costume accessories: list installed costumes, check wing status, change active costumes, install new costumes.',
    coreActions: {
      list: listAction,
      status: statusAction,
      change: makeChangeAction(port),
      'sync-all': makeSyncAllAction(port),
    },
    secondaryActions: {
      install: installAction,
      'debug-install': debugInstallAction,
      'install-from-marketplace': installFromMarketplaceAction,
      'install-from-registry': installFromRegistryAction,
      publish: publishAction,
    },
  };
}
