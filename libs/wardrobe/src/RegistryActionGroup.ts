/**
 * RegistryActionGroup — MCP action group for managing costume registries.
 *
 * Core actions:
 *   list   — list all configured registries from cabinet.config.json
 *
 * Secondary actions:
 *   add    — add a registry to cabinet.config.json
 *   remove — remove a registry from cabinet.config.json
 */

import type { Directory, File } from '@minions/file-store';
import type { ActionGroupDef } from '@minions/mcp-types';

const CONFIG_FILE = 'cabinet.config.json';

// ---------------------------------------------------------------------------
// Inline registry config types (structural — avoids importing from cabinet)
// ---------------------------------------------------------------------------

interface RegistryAuth {
  type: 'github-token';
  envVar: string;
}

interface RegistryConfig {
  indexBaseUrl: string;
  publishApi?: string;
  publishDirect?: { indexRepo: string };
  auth?: RegistryAuth;
}

interface CabinetConfig {
  port: number;
  registries?: Record<string, RegistryConfig>;
  defaultRegistry?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// ActionContext — structural type matching cabinet's dispatcher
// ---------------------------------------------------------------------------

interface ActionContext {
  lair: { root: Directory };
  wingName?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Cabinet config read/write helpers
// ---------------------------------------------------------------------------

async function readCabinetConfig(lairRoot: Directory): Promise<CabinetConfig | null> {
  const result = await lairRoot.child(CONFIG_FILE);
  if (!result.found || !result.node.is('file')) return null;
  try {
    const content = await (result.node as File).read();
    const config = JSON.parse(content) as CabinetConfig;
    if (typeof config.port === 'number') return config;
    return null;
  } catch {
    return null;
  }
}

async function writeCabinetConfig(lairRoot: Directory, config: CabinetConfig): Promise<void> {
  const content = JSON.stringify(config, null, 2);
  const result = await lairRoot.child(CONFIG_FILE);
  if (result.found && result.node.is('file')) {
    await (result.node as File).write(content);
  } else {
    await lairRoot.createFile(CONFIG_FILE, content);
  }
}

function getLairRoot(ctx: ActionContext): Directory {
  return ctx.lair.root as Directory;
}

// ---------------------------------------------------------------------------
// action: list
// ---------------------------------------------------------------------------

const listAction = {
  description: 'list all configured costume registries',
  help: `**registry list** — Show all registries configured in cabinet.config.json.

Returns: { action: 'list', registries: Array<{ name, indexBaseUrl, hasPublishApi, hasPublishDirect, auth? }>, defaultRegistry: string | null }`,
  params: {} as Record<string, never>,
  required: [] as string[],
  async execute(ctx: ActionContext, _params: Record<string, unknown>) {
    const lairRoot = getLairRoot(ctx);
    const config = await readCabinetConfig(lairRoot);
    const raw = config?.registries ?? {};
    const registries = Object.entries(raw).map(([name, r]) => ({
      name,
      indexBaseUrl: r.indexBaseUrl,
      hasPublishApi: !!r.publishApi,
      hasPublishDirect: !!r.publishDirect,
      ...(r.auth ? { auth: r.auth } : {}),
    }));
    return {
      action: 'list',
      registries,
      defaultRegistry: config?.defaultRegistry ?? null,
    };
  },
};

// ---------------------------------------------------------------------------
// secondary action: add
// ---------------------------------------------------------------------------

const addAction = {
  description: 'add or update a costume registry in cabinet.config.json',
  help: `**registry add** — Add or update a named registry in cabinet.config.json.

Required: name, indexBaseUrl
Optional: publishApi (Worker URL), publishDirectRepo (owner/repo for direct GitHub publishing),
          authEnvVar (env var name for a private registry token), setDefault (set as default registry)

Returns: { action: 'add', name, registry }`,
  params: {
    name: {
      type: 'string' as const,
      description: 'Registry name (e.g. "official", "untangler")',
    },
    indexBaseUrl: {
      type: 'string' as const,
      description: 'Base URL for index files, e.g. "https://raw.githubusercontent.com/owner/repo/main"',
    },
    publishApi: {
      type: 'string' as const,
      description: 'Cloudflare Worker URL for publishing (publishApi path)',
    },
    publishDirectRepo: {
      type: 'string' as const,
      description: 'GitHub "owner/repo" for direct publishing via Contents API (publishDirect path)',
    },
    authEnvVar: {
      type: 'string' as const,
      description: 'Environment variable name holding the GitHub token (for private registries)',
    },
    setDefault: {
      type: 'boolean' as const,
      description: 'Set this registry as the default for installs (default: false)',
    },
  },
  required: ['name', 'indexBaseUrl'] as string[],
  async execute(ctx: ActionContext, params: Record<string, unknown>) {
    const name = params['name'] as string;
    const indexBaseUrl = params['indexBaseUrl'] as string;
    const publishApi = params['publishApi'] as string | undefined;
    const publishDirectRepo = params['publishDirectRepo'] as string | undefined;
    const authEnvVar = params['authEnvVar'] as string | undefined;
    const setDefault = params['setDefault'] as boolean | undefined;

    const lairRoot = getLairRoot(ctx);
    const existing = await readCabinetConfig(lairRoot);
    if (!existing) {
      throw new Error('cabinet.config.json not found — cabinet must be initialized first');
    }

    const registry: RegistryConfig = { indexBaseUrl };
    if (publishApi) registry.publishApi = publishApi;
    if (publishDirectRepo) registry.publishDirect = { indexRepo: publishDirectRepo };
    if (authEnvVar) registry.auth = { type: 'github-token', envVar: authEnvVar };

    const updated: CabinetConfig = {
      ...existing,
      registries: { ...existing.registries, [name]: registry },
    };
    if (setDefault) updated.defaultRegistry = name;

    await writeCabinetConfig(lairRoot, updated);

    return { action: 'add', name, registry };
  },
};

// ---------------------------------------------------------------------------
// secondary action: remove
// ---------------------------------------------------------------------------

const removeAction = {
  description: 'remove a costume registry from cabinet.config.json',
  help: `**registry remove** — Remove a named registry from cabinet.config.json.

Required: name
Returns: { action: 'remove', name, removed: boolean }`,
  params: {
    name: {
      type: 'string' as const,
      description: 'Registry name to remove',
    },
  },
  required: ['name'] as string[],
  async execute(ctx: ActionContext, params: Record<string, unknown>) {
    const name = params['name'] as string;
    const lairRoot = getLairRoot(ctx);
    const existing = await readCabinetConfig(lairRoot);
    if (!existing?.registries?.[name]) {
      return { action: 'remove', name, removed: false };
    }

    const { [name]: _removed, ...rest } = existing.registries;
    const updated: CabinetConfig = { ...existing, registries: rest };

    // Clear defaultRegistry if it pointed to the removed registry
    if (updated.defaultRegistry === name) {
      delete updated.defaultRegistry;
    }

    await writeCabinetConfig(lairRoot, updated);
    return { action: 'remove', name, removed: true };
  },
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRegistryActionGroup(): ActionGroupDef {
  return {
    name: 'registry',
    description: 'Manage costume registries: list configured registries, add new ones, or remove existing ones.',
    coreActions: {
      list: listAction,
    },
    secondaryActions: {
      add: addAction,
      remove: removeAction,
    },
  };
}
