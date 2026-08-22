import express from 'express';
import type { Express } from 'express';
import path from 'path';
import cors from 'cors';
import { createDiskSandbox, createLair, createWorkAreaFactoriesForSandbox, type Sandbox, type Directory, type DirectoryLike, type Lair } from '@minions/file-store';
import { CodeExecutionSecretary } from './secretary.js';
import { WingManager } from './wings/WingManager.js';
import { MinionManager } from '@minions/minions-runtime-core';
import { ProductionHatchery } from '@minions/hatchery';
import { ClosetExtensionLoader } from '@minions/costumes';
import { MCPServer } from './mcp/MCPServer.js';
import type { EndpointName } from './mcp/ToolRegistry.js';
import { initFlags } from '@minions/feature-flags';
import { createPlanActionGroup, setQualityWatcherFactory } from '@minions/planner';
import type { QualityWatcherFactory } from '@minions/quality-watcher';
import { movementActionGroup } from '@minions/minions-runtime-core';
import { createCostumesActionGroup, createRegistryActionGroup } from '@minions/wardrobe';
import { createDocsActionGroup } from './docs/DocsActionGroup.js';
import { askActionGroup } from './questions/AskActionGroup.js';
import { readCabinetConfig, writeCabinetConfig } from './utils/portConfig.js';
import { createSharedBrowserService } from './browser/config.js';

/**
 * Heals every work repo in a lair that was provisioned the old way (where
 * `git clone --bare` created a non-tracking local branch per remote branch).
 * Idempotent and best-effort — repos cloned the new (tracking) way are no-ops.
 */
async function normalizeWorkRepoBranches(lair: Lair): Promise<void> {
  try {
    const repos = await lair.workRepos();
    for (const repo of repos) {
      try {
        const deleted = await repo.normalizeLocalBranches();
        if (deleted.length > 0) {
          console.log(
            `[server] Normalized ${repo.name}: pruned ${deleted.length} stale local branch(es) [${deleted.join(', ')}]`
          );
        }
      } catch (error) {
        console.warn(`[server] Failed to normalize work repo ${repo.name}:`, error);
      }
    }
  } catch (error) {
    console.warn('[server] Failed to enumerate work repos for normalization:', error);
  }
}

export interface CreateServerOptions {
  /** Path to lair root (used to create DiskSandbox if sandbox not provided) */
  lairRoot?: string;
  /** Pre-configured sandbox (for testing with in-memory sandbox) */
  sandbox?: Sandbox;
  /** The port the cabinet is listening on, used to configure wing MCP settings */
  cabinetPort?: number;
  /** Whether cabinet is running in dev mode (from source in a wing, not a built product) */
  isDevMode?: boolean;
  /** Real release version in production; short git commit sha in dev. Reported in the MCP initialize handshake. */
  version?: string;
  /** The wing this dev instance runs from — irrelevant in production. Reported in the MCP initialize handshake. */
  wingName?: string;
  /**
   * Optional module loader for TypeScript mission files.
   * When running under vite-node (dev mode), pass the ViteNodeRunner's executeId so that
   * mission TypeScript source files and their @minions/* imports are resolved through Vite.
   */
  moduleLoader?: (url: string) => Promise<Record<string, unknown>>;
}

export async function createServer(options: CreateServerOptions | string = {}): Promise<Express> {
  // Support legacy string parameter for backwards compatibility
  const opts: CreateServerOptions = typeof options === 'string'
    ? { lairRoot: options }
    : options;

  initFlags(opts.isDevMode ?? false);

  // Captured lair directory for use in auth endpoints (set below if sandbox is available)
  let authLairDir: Directory | null = null;

  const app = express();

  app.use(cors({
    // Driven by the same isDevMode flag createServer() already receives (and
    // passes to initFlags above) — never process.env.NODE_ENV, which nothing
    // sets automatically when running from source in a wing (dev-server.mjs,
    // vite-node, etc.), so relying on it silently breaks the Portal's CORS
    // unless a developer remembers to export NODE_ENV=development by hand.
    origin: opts.isDevMode
      ? (origin, cb) => {
          // Allow any localhost:5xxx origin (Vite picks sequential ports when 5173 is taken)
          if (!origin || /^http:\/\/localhost:5\d{3}$/.test(origin)) cb(null, true);
          else cb(new Error('Not allowed by CORS'));
        }
      : false,
    // Expose MCP headers for cross-origin clients to read
    exposedHeaders: ['mcp-session-id', 'mcp-protocol-version'],
    // Allow all MCP headers to be sent in requests
    allowedHeaders: [
      'Content-Type',
      'Accept',
      'mcp-session-id',
      'mcp-protocol-version',
      'Last-Event-ID', // For StreamableHTTP reconnection
    ],
    // Allow credentials for session management
    credentials: true,
  }));

  app.use(express.json());

  const secretary = new CodeExecutionSecretary();

  // Initialize minion manager
  const minionManager = new MinionManager();
  app.locals.minionManager = minionManager;

  // Initialize MCP server with SDK
  const mcpServer = new MCPServer();

  // Register lair_get_state tool metadata
  mcpServer.registerTool({
    name: 'lair_get_state',
    description: 'Get complete lair state including wings, available work repos, and lair configuration',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  });

  // Register wings tool (create/delete/update)
  mcpServer.registerTool({
    name: 'wings',
    description: [
      'Manage wings (agent workspaces). Each wing is a git worktree with one or more named work/ directories backed by bare-repo worktrees.',
      '',
      'Actions (CSV): action,description,key params',
      'create,Create a new wing with git worktrees and MCP config,name + workLocalRepo (required); extraWork,trunk (optional)',
      'delete,Delete a wing and remove all its worktrees,name',
      'update,Reconfigure an existing wing — add or remove named work/ directories without destroying the wing or its history,name + addWork and/or removeWork',
      'set-trunk,Set or clear an existing wing\'s work/local trunk override (which branch movement/plan operations target instead of the repo default),name + trunk',
      'reprovision-hooks,Install or update the tool log hook in one or all wings (idempotent — safe to re-run),name (optional; omit to reprovision all wings)',
      'sync-wing,"Re-apply every provisioned wing file (CLAUDE.md, .mcp.json, .claude/settings.json, tool log hook) to the current standard — idempotent, leaves work/ and private/ untouched",name (optional; omit to sync all wings)',
      '',
      'Use **update** when: you need to give a wing access to an additional repository (addWork), or remove a work directory it no longer needs (removeWork). The wing itself and all other work dirs are left untouched.',
      'Use **create** when provisioning a brand-new wing. Pass extraWork to give it multiple work repos from the start. Pass trunk to point it at a branch other than the repo default from the start (e.g. an experiment branch).',
      'Use **set-trunk** to retarget (or clear, passing trunk:null) an existing wing\'s movement/plan trunk without recreating it — e.g. when assigning it to (or freeing it from) an experiment.',
      'Use **reprovision-hooks** to install the tool log hook into existing wings that were created before this feature was added.',
      'Use **sync-wing** to bring one or all existing wings\' provisioned files (CLAUDE.md template, MCP config, settings, hooks) up to whatever the current wing-setup standard is — e.g. after that standard changes. Only touches wing-root provisioning files, never the wing\'s work repos.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'delete', 'update', 'set-trunk', 'reprovision-hooks', 'sync-wing'],
          description: 'Action to perform: create | delete | update | set-trunk | reprovision-hooks | sync-wing'
        },
        name: {
          type: 'string',
          description: 'Name of the wing'
        },
        description: {
          type: 'string',
          description: "Description of the wing's purpose (create only)"
        },
        workLocalRepo: {
          type: 'string',
          description: 'Work repository name, e.g. "suite" (create only)'
        },
        extraWork: {
          type: 'object',
          description: 'Additional named work directories to create alongside work/local (create only). Keys are directory names (not "local"/"global"), values are {repo, branch, subdir?} objects.',
          additionalProperties: {
            type: 'object',
            properties: {
              repo: { type: 'string', description: 'Work repository name' },
              branch: { type: 'string', description: 'Branch to check out' },
              subdir: { type: 'string', description: 'Subdirectory within the repo to expose (optional). If the repo is already mapped to the wing, creates a junction into the existing worktree; otherwise creates a sparse-checkout worktree.' }
            },
            required: ['repo', 'branch']
          }
        },
        addWork: {
          type: 'object',
          description: 'Named work directories to add to an existing wing (update only). Keys are directory names, values are {repo, branch, subdir?} objects.',
          additionalProperties: {
            type: 'object',
            properties: {
              repo: { type: 'string', description: 'Work repository name' },
              branch: { type: 'string', description: 'Branch to check out' },
              subdir: { type: 'string', description: 'Subdirectory within the repo to expose (optional). If the repo is already mapped to the wing, creates a junction into the existing worktree; otherwise creates a sparse-checkout worktree.' }
            },
            required: ['repo', 'branch']
          }
        },
        removeWork: {
          type: 'array',
          description: 'Names of work directories to remove from an existing wing (update only).',
          items: { type: 'string' }
        },
        trunk: {
          type: ['string', 'null'],
          description: 'Branch this wing\'s work/local movement/plan operations should target instead of the repo default (create: sets it at creation; set-trunk: retargets an existing wing, or pass null to clear back to the repo default; required for set-trunk).'
        }
      },
      required: ['action']
    }
  });

  // Register experiments tool (list/get/create/assign-wing/unassign-wing/select-winner)
  mcpServer.registerTool({
    name: 'experiments',
    description: [
      'Manage experiments — named, parallel explorations where each variation gets its own trunk branch that assigned wings\' movement/plan operations target instead of main.',
      '',
      'Actions (CSV): action,description,key params',
      'list,List all experiments,repo (optional)',
      'get,Get one experiment by id,id + repo (optional)',
      'create,"Create an experiment: cuts an experiment/<id>/<slug> branch off origin/main for each variation, no wings assigned yet",id + variations (required); repo (optional)',
      'assign-wing,"Assign a wing to a variation: sets the wing\'s trunk override to that variation\'s branch and records the assignment",id + slug + wingName (required); repo (optional)',
      'unassign-wing,"Unassign a wing from a variation: clears the wing\'s trunk override back to main and removes the assignment",id + slug + wingName (required); repo (optional)',
      'select-winner,"Throne-room only: designates a variation as the winner (status becomes completing) and unassigns every wing on every non-winning variation — no git merge happens here, that is movement promote\'s job",id + winnerSlug (required); repo (optional)',
      '',
      'Starting an experiment (create/assign-wing) can happen from the throne room or the conductor. Picking a result (select-winner) is throne-room only. Unassigning a wing (unassign-wing) is manual and one-at-a-time; select-winner and movement promote also unassign wings as a side effect (non-winning variations, and all variations, respectively).',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'create', 'assign-wing', 'unassign-wing', 'select-winner'],
          description: 'Action to perform: list | get | create | assign-wing | unassign-wing | select-winner'
        },
        id: {
          type: 'string',
          description: 'Experiment id (required for get/create/assign-wing/unassign-wing/select-winner)'
        },
        repo: {
          type: 'string',
          description: 'Which lair-registered work repo the experiment belongs to. Defaults to "local".'
        },
        variations: {
          type: 'array',
          description: 'Variations to create (create only) — each gets its own experiment/<id>/<slug> branch.',
          items: {
            type: 'object',
            properties: {
              slug: { type: 'string', description: 'Short identifier for this variation, unique within the experiment' }
            },
            required: ['slug']
          }
        },
        slug: {
          type: 'string',
          description: 'Variation slug to assign/unassign a wing to (assign-wing/unassign-wing only)'
        },
        wingName: {
          type: 'string',
          description: 'Wing to assign/unassign to the variation (assign-wing/unassign-wing only)'
        },
        winnerSlug: {
          type: 'string',
          description: 'Variation slug to designate as the winner (select-winner only)'
        }
      },
      required: ['action']
    }
  });

  // Register archives tool (list/add/remove)
  mcpServer.registerTool({
    name: 'archives',
    description: 'Manage lair archives (git repositories). Actions: list (list all archives), add (clone or create), remove (delete)',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'remove'],
          description: 'Action to perform'
        },
        type: {
          type: 'string',
          enum: ['work', 'info', 'private'],
          description: 'Type of archive: work (bare repo), info (regular repo), or private (directory). Required for add/remove.'
        },
        name: {
          type: 'string',
          description: 'Name for the archive. For private, must be "local" or "global". Required for add/remove.'
        },
        url: {
          type: 'string',
          description: 'Git repository URL (add only, required for work/info)'
        },
        auth: {
          type: 'object',
          description: 'Optional authentication for private repos (add only)',
          properties: {
            username: { type: 'string', description: 'Username (required for Bitbucket)' },
            token: { type: 'string', description: 'Auth token or app password' }
          },
          required: ['token']
        },
        branch: {
          type: 'string',
          description: 'Branch to checkout (add, info archives only)'
        }
      },
      required: ['action']
    }
  });

  // Register minions tool (spawn/list/get_history/get_interactions/get_interaction_detail/send_message/kill)
  mcpServer.registerTool({
    name: 'minions',
    description: 'Manage minions. Actions: spawn (create a new minion), list (list minions), get_history (conversation history), get_interactions (raw API interactions), get_interaction_detail (single interaction detail), send_message (send message with streaming response), kill (terminate a minion)',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['spawn', 'list', 'get_history', 'get_interactions', 'get_interaction_detail', 'send_message', 'kill'],
          description: 'Action to perform'
        },
        wingName: {
          type: 'string',
          description: 'Wing name (required for spawn; optional filter for list)'
        },
        client: {
          type: 'string',
          enum: ['claude-code', 'anthropic-agentic', 'opencode', 'code-puppy'],
          description: 'Client type (spawn only)'
        },
        agentPrompt: {
          type: 'string',
          description: 'Custom agent prompt (spawn only, optional)'
        },
        minionId: {
          type: 'string',
          description: 'Minion ID (required for get_history, get_interactions, get_interaction_detail, send_message, kill)'
        },
        interactionId: {
          type: 'string',
          description: 'Interaction ID (get_interaction_detail only)'
        },
        message: {
          type: 'string',
          description: 'Message to send (send_message only)'
        }
      },
      required: ['action']
    }
  });

  // Mount unified ask tool via ActionGroupDef. blocking/nonblocking/await are
  // minion-side (henchery — wingName comes from the henchery URL, sessionId
  // identifies the asking minion); list/answer are overlord-side (throne —
  // the Throne Room UI polls open questions and submits answers).
  mcpServer.mountActionGroup(askActionGroup, ['henchery', 'throne'], {
    blocking:    ['henchery'],
    nonblocking: ['henchery'],
    await:       ['henchery'],
    list:        ['throne'],
    answer:      ['throne'],
  });

  // Mount unified movement tool via ActionGroupDef. start/commit/merge/status
  // stay henchery-only (wing comes from the session URL); diff is throne-only
  // (no per-wing URL there, so it takes an explicit `wing` param instead).
  mcpServer.mountActionGroup(movementActionGroup, ['henchery', 'throne'], {
    start:  ['henchery'],
    commit: ['henchery'],
    merge:  ['henchery'],
    status: ['henchery'],
    diff:   ['throne'],
  });

  // Register missions tool (list/start/events/cancel/running)
  mcpServer.registerTool({
    name: 'missions',
    description: 'Manage missions. Actions: list (list available missions in a wing\'s closet), start (start a mission), events (get events from a running/completed mission), cancel (cancel a running mission), running (list currently tracked mission runs)',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'start', 'events', 'cancel', 'running'],
          description: 'Action to perform'
        },
        wingName: {
          type: 'string',
          description: 'Wing name (required for list/start; optional filter for running)'
        },
        costume: {
          type: 'string',
          description: 'Costume containing the mission (start only)'
        },
        mission: {
          type: 'string',
          description: 'Mission name to start (start only)'
        },
        args: {
          type: 'object',
          description: 'Arguments to pass to the mission (start only)'
        },
        missionRunId: {
          type: 'string',
          description: 'Mission run ID (required for events/cancel)'
        },
        reason: {
          type: 'string',
          description: 'Reason for cancellation (cancel only, optional)'
        }
      },
      required: ['action']
    }
  });

  // Register quality watcher tool
  mcpServer.registerTool({
    name: 'quality_status',
    description: 'Real-time test, type, lint, and build results for this wing — check this instead of running `pnpm test`/`tsc`/lint/build yourself; results are continuously kept warm in the background, and lint (which has no watch mode of its own) is checked fresh on demand whenever the codebase changed since it last ran. By default, any warning (e.g. a deprecation notice) reported by an otherwise-passing signal is treated as a failure, so warnings can\'t quietly accumulate unaddressed — pass treatWarningsAsWarnings to see raw pass/fail with warnings reported separately and non-blocking.',
    inputSchema: {
      type: 'object',
      properties: {
        treatWarningsAsWarnings: {
          type: 'boolean',
          description: 'When true, a signal with warnings keeps its own pass/fail state instead of being reported as fail. Default false.'
        }
      }
    }
  });

  // Mount plan tool via ActionGroupDef

  // Register review tool
  mcpServer.registerTool({
    name: 'review',
    description: 'Start a human-in-the-loop document review session. Presents documents in the Throne Room WYSIWYG UI, waits for human edits and @ai: comments, spawns a resolver to apply them, and loops until the human approves. Blocks until the review is complete.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Document paths to review, relative to work/local root'
        },
        purpose: { type: 'string', description: 'What the document set is for — shapes resolver decisions' },
        scope: { type: 'string', description: 'Root directory for propagating normative edits (optional, defaults to common parent of paths)' },
        callerSessionId: { type: 'string', description: 'Session ID of the calling minion for context inheritance (optional)' },
        wingName: { type: 'string', description: 'Wing to operate on (optional — inferred from session context when omitted)' }
      },
      required: ['paths', 'purpose']
    }
  });

  mcpServer.registerTool({
    name: 'gsd_compute_frames',
    description: 'Have Jarvis (AI) analyze plan items and compute GSD work frames for the product owner. Returns focused work bundles grouped by operational mode (unblock, refine, pathfind, risk-scan, capture).',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'object',
          description: 'Plan items keyed by id (PlanItemRecordView format)',
          additionalProperties: true,
        },
        rootIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of top-level plan root items',
        },
      },
      required: ['items', 'rootIds'],
    },
  });

  mcpServer.mountActionGroup(createPlanActionGroup(), ['henchery', 'conductor', 'throne'], {
    // Overlord-only: ordering. Approval/planning status are henchery-writable
    // via update-item's `approved` param, which has no per-field permission
    // gate — consistent with `ready`, which is in the same position.
    'set-root-order':    ['conductor', 'throne'],
    // Creating new roots: available to wings (henchery) as well as the overlord
    'create-root':       ['henchery', 'conductor', 'throne'],
    // Wing-only: claiming work, marking it demoable, and marking items done
    'claim-node':        ['henchery'],
    'mark-demo':         ['henchery'],
    // Delete a subtree, permanently — henchery uses it to mark completed work
    // done; throne exposes it to the overlord as "Complete Item".
    'delete-subtree':    ['henchery', 'throne'],
  });
  mcpServer.mountActionGroup(createCostumesActionGroup(opts.cabinetPort ?? 0), ['henchery', 'lair']);
  mcpServer.mountActionGroup(createRegistryActionGroup(), ['henchery', 'lair', 'throne']);
  mcpServer.mountActionGroup(createDocsActionGroup(opts.cabinetPort ?? 0), ['henchery', 'lair', 'throne']);

  await mcpServer.connect();
  app.locals.mcpServer = mcpServer;

  // Initialize wing manager if sandbox or lairRoot provided
  const sandbox = opts.sandbox ?? (opts.lairRoot ? createDiskSandbox(opts.lairRoot, mcpServer.gitCoordination) : null);

  if (sandbox) {
    const lairDir = sandbox.root;
    authLairDir = lairDir as Directory;
    const lairRoot = opts.lairRoot ?? sandbox.root.path;

    // Create Lair for archive operations and wing manager. Wired with real
    // `WorkAreaFactories` (design doc §4.2/§4.3) so the additive
    // `workAreaLocal()`/`workAreaGlobal()`/`workAreaNamed()`/
    // `privateWorkAreaGlobal()`/`scratchpad()` surface on every production
    // `Wing` actually works, rather than throwing "no WorkAreaFactories"
    // whenever a caller of it is invoked outside a test. Same
    // `{cabinet}/movement-scratch` directory convention `WingManager.
    // getWorkAreaFactories()`/`ExperimentsService.getWorkAreaFactories()`
    // use for their own hand-built `WorkArea`s, so movement scratch
    // worktrees created via any of these three paths land in one place.
    const bootstrapLair = createLair(sandbox);
    const cabinetDir = await bootstrapLair.cabinet();
    const scratchRootResult = await cabinetDir.child('movement-scratch');
    const scratchRoot: Directory =
      scratchRootResult.found && scratchRootResult.node.is('directory')
        ? (scratchRootResult.node as Directory)
        : await cabinetDir.createDirectory('movement-scratch');
    const workAreaFactories = createWorkAreaFactoriesForSandbox(sandbox, scratchRoot);
    const lair = createLair(sandbox, workAreaFactories);

    const wingManager = new WingManager(lair, opts.cabinetPort ?? 0);

    // Initialize production hatchery with lair
    const productionHatchery = new ProductionHatchery(lair);
    app.locals.productionHatchery = productionHatchery;

    // Scan on startup
    wingManager.scan().catch(console.error);

    // There is no eager plan/main mirror bootstrap or periodic mirror-sync
    // backstop here. Under invariant A, `LairRepoPerspective` constructs a
    // fresh, always-synced `Trunk.mirror()` on every `plan` action call,
    // creating the mirror worktree on demand if it doesn't exist yet (see
    // `LairRepoPerspective.resolve`'s own doc comment) — so freshness does
    // not depend on a periodic backstop (design doc §5: "safe to run on a
    // timer or not run at all"), and no eager startup step is needed either,
    // since the first real `plan` call for any repo creates its own mirror
    // lazily. A repo's plan mirror worktree, once created by the first real
    // call, is reused by every later call.

    // Conductor state lives on the SAME `plan/<trunk>` mirror worktree plan
    // actions use (see `@minions/repo-perspective`'s
    // `resolveConductorMirror`) — there is no separate `conductor/<trunk>`
    // branch/mirror, so there is nothing to periodically realign there
    // either. It's materialized lazily on first real access, the same way
    // plan's own mirror is.

    // Upgrade old lairs: prune the non-tracking local branch litter left by
    // older `git clone --bare` provisioning, and set tracking on kept branches.
    normalizeWorkRepoBranches(lair).catch(console.error);

    // Get wings directory for file-store operations
    let wingsDir: Directory;
    const wingsDirResult = await lairDir.child('wings');
    if (wingsDirResult.found && wingsDirResult.node.is('directory')) {
      wingsDir = wingsDirResult.node as Directory;
    } else {
      wingsDir = await lairDir.createDirectory('wings');
    }

    // Make available to MCP handlers
    app.locals.wingManager = wingManager;
    app.locals.lair = lair;
    app.locals.lairRoot = lairRoot;
    app.locals.sandbox = sandbox;
    app.locals.lairDir = lairDir;
    app.locals.wingsDir = wingsDir;

    // The real QualityWatcherFactory (see MCPServer's `qualityWatcherFactory`
    // field doc comment): imported dynamically, via a non-literal specifier
    // TypeScript can't resolve at compile time, so this file type-checks
    // identically whether or not the production composition file is present
    // in this checkout. It won't be in a `minions-platform`-only extraction
    // (see docs/design/repo-split-analysis.md) — every consumer of the
    // factory already tolerates `undefined` as "no watcher available".
    let qualityWatcherFactory: QualityWatcherFactory | undefined;
    try {
      const modulePath = './quality/productionQualityWatcherFactory.js';
      const mod = (await import(modulePath)) as {
        createProductionQualityWatcherFactory: (lairRoot: string) => QualityWatcherFactory;
      };
      qualityWatcherFactory = mod.createProductionQualityWatcherFactory(lairRoot);
    } catch {
      // Not available in this checkout — quality watching stays off.
    }
    setQualityWatcherFactory(qualityWatcherFactory);

    // Initialize MCP server with dependencies
    mcpServer.initialize(
      wingManager,
      lairRoot,
      lair,
      minionManager,
      productionHatchery,
      sandbox,
      wingsDir,
      opts.moduleLoader,
      { isDevMode: opts.isDevMode ?? false, version: opts.version ?? 'unknown', wingName: opts.wingName },
      qualityWatcherFactory
    );

    // Shared verification browser: one Chrome per lair, owned by the cabinet.
    // Kept as an internal JS singleton (no MCP/HTTP surface of its own). M3's
    // browser-verify costume drives exposure through the cabinet's MCP proxy, which
    // will call this service to resolve `--browserUrl` when it spawns
    // chrome-devtools-mcp — also the insertion point for future tool/URL policy.
    app.locals.sharedBrowser = createSharedBrowserService(lairRoot, lairDir, {
      cabinetPort: opts.cabinetPort,
    });
    // Let the MCP proxy resolve `--browserUrl` from this service when it spawns
    // `sharedBrowser`-flagged costume servers (e.g. browser-verify/chrome-devtools-mcp).
    mcpServer.setSharedBrowser(app.locals.sharedBrowser);

    // Load registry configuration from cabinet.config.json
    try {
      const cabinetConfig = await readCabinetConfig(lairDir);
      if (cabinetConfig?.registries) {
        mcpServer.setRegistries(
          cabinetConfig.registries,
          cabinetConfig.defaultRegistry ?? 'official'
        );
      }
      if (cabinetConfig?.githubAuth) {
        mcpServer.setGithubAuth(cabinetConfig.githubAuth.token, cabinetConfig.githubAuth.connectedAs);
      }
    } catch (error) {
      console.warn('[server] Failed to load registry config:', error);
    }

    // Discover and register costume-provided extensions from the lair closet.
    // Action groups are not wired here yet (tracked separately); only flat
    // gadget mounts are registered, matching the prior gadget-only behavior.
    try {
      const closetResult = await lairDir.child('closet');
      if (closetResult.found && closetResult.node.isDirectoryLike()) {
        const extensionLoader = new ClosetExtensionLoader({ closetDir: closetResult.node as DirectoryLike });
        const loadedExtensions = await extensionLoader.loadAll();
        let gadgetCount = 0;
        for (const { costumeName, extensions } of loadedExtensions) {
          for (const { gadget } of extensions.gadgets ?? []) {
            mcpServer.registerGadget(costumeName, gadget);
            gadgetCount++;
          }
          if (extensions.actionGroups && extensions.actionGroups.length > 0) {
            console.warn(
              `[server] Costume "${costumeName}" declares action group(s) via extensions.ts, ` +
              `but costume-declared action group mounting is not yet wired — they will not be registered.`
            );
          }
        }
        if (gadgetCount > 0) {
          console.log(`[server] Registered ${gadgetCount} gadget(s)`);
        }
      }
    } catch (error) {
      console.error('[server] Failed to load costume extensions:', error);
    }

  }

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  // ---------------------------------------------------------------------------
  // GitHub Device Flow auth endpoints
  //
  // Flow:
  //   1. POST /auth/github/start — begin device flow, returns user_code + verification_uri
  //   2. GET  /auth/github/poll  — poll for completion, returns { status, connectedAs? }
  //   3. DELETE /auth/github/token — clear stored token
  // ---------------------------------------------------------------------------

  // In-memory device flow state (one active flow at a time per cabinet instance)
  let pendingDeviceFlow: {
    deviceCode: string;
    interval: number;
    expiresAt: number;
  } | null = null;

  app.post('/auth/github/start', async (_req, res) => {
    try {
      if (!authLairDir) {
        res.status(503).json({ error: 'Cabinet not initialized with a lair' });
        return;
      }
      const config = await readCabinetConfig(authLairDir);
      const clientId = config?.githubApp?.clientId;
      if (!clientId) {
        res.status(400).json({
          error: 'GitHub App not configured. Add githubApp.clientId to cabinet.config.json.',
        });
        return;
      }

      const resp = await fetch('https://github.com/login/device/code', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, scope: 'repo' }),
      });
      if (!resp.ok) {
        res.status(502).json({ error: `GitHub device flow error: ${resp.status}` });
        return;
      }
      const data = await resp.json() as {
        device_code: string;
        user_code: string;
        verification_uri: string;
        expires_in: number;
        interval: number;
      };

      pendingDeviceFlow = {
        deviceCode: data.device_code,
        interval: data.interval,
        expiresAt: Date.now() + data.expires_in * 1000,
      };

      res.json({
        user_code: data.user_code,
        verification_uri: data.verification_uri,
        expires_in: data.expires_in,
        interval: data.interval,
      });
    } catch (err) {
      console.error('[auth] /auth/github/start error:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  app.get('/auth/github/poll', async (_req, res) => {
    try {
      if (!pendingDeviceFlow) {
        res.json({ status: 'none' });
        return;
      }
      if (Date.now() > pendingDeviceFlow.expiresAt) {
        pendingDeviceFlow = null;
        res.json({ status: 'expired' });
        return;
      }

      if (!authLairDir) {
        res.status(503).json({ error: 'Cabinet not initialized with a lair' });
        return;
      }
      const config = await readCabinetConfig(authLairDir);
      const clientId = config?.githubApp?.clientId;
      if (!clientId) {
        res.status(400).json({ error: 'GitHub App not configured' });
        return;
      }

      const tokenResp = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          device_code: pendingDeviceFlow.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });

      const tokenData = await tokenResp.json() as {
        access_token?: string;
        error?: string;
        token_type?: string;
      };

      if (tokenData.access_token) {
        // Fetch the authenticated user
        const userResp = await fetch('https://api.github.com/user', {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            'User-Agent': 'costume-registry-publisher/1.0',
          },
        });
        const userData = userResp.ok
          ? (await userResp.json() as { login: string })
          : { login: 'unknown' };

        // Persist token to cabinet.config.json
        const now = new Date().toISOString();
        const updatedConfig = {
          ...(config ?? { port: opts.cabinetPort ?? 0 }),
          githubAuth: {
            token: tokenData.access_token,
            connectedAs: userData.login,
            connectedAt: now,
          },
        };
        await writeCabinetConfig(authLairDir, updatedConfig);
        mcpServer.setGithubAuth(tokenData.access_token, userData.login);
        pendingDeviceFlow = null;

        res.json({ status: 'authorized', connectedAs: userData.login });
        return;
      }

      if (tokenData.error === 'authorization_pending') {
        res.json({ status: 'pending' });
        return;
      }

      if (tokenData.error === 'access_denied') {
        pendingDeviceFlow = null;
        res.json({ status: 'denied' });
        return;
      }

      // slow_down or other — just report pending
      res.json({ status: 'pending' });
    } catch (err) {
      console.error('[auth] /auth/github/poll error:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  app.delete('/auth/github/token', async (_req, res) => {
    try {
      pendingDeviceFlow = null;
      if (authLairDir) {
        const config = await readCabinetConfig(authLairDir);
        if (config) {
          const { githubAuth: _removed, ...rest } = config;
          await writeCabinetConfig(authLairDir, rest);
        }
      }
      mcpServer.setGithubAuth(null, null);
      res.json({ success: true });
    } catch (err) {
      console.error('[auth] /auth/github/token DELETE error:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  app.get('/auth/github/status', async (_req, res) => {
    try {
      const config = authLairDir ? await readCabinetConfig(authLairDir) : null;
      const auth = config?.githubAuth;
      if (auth) {
        res.json({ connected: true, connectedAs: auth.connectedAs, connectedAt: auth.connectedAt });
      } else {
        res.json({ connected: false });
      }
    } catch (err) {
      console.error('[auth] /auth/github/status error:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });


  // MCP endpoints - using official MCP SDK with StreamableHTTP (per-session mode)
  // Helper to mount POST/GET/DELETE for a named endpoint
  const mountMcpEndpoint = (path: string, endpoint: EndpointName) => {
    app.post(path, async (req, res) => {
      const mcp: MCPServer = app.locals.mcpServer;
      try {
        await mcp.handleRequest(req, res, endpoint);
      } catch (error) {
        console.error(`MCP POST request error (${path}):`, error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            id: req.body?.id,
            error: { code: -32603, message: error instanceof Error ? error.message : 'Internal error' }
          });
        }
      }
    });
    app.get(path, async (req, res) => {
      const mcp: MCPServer = app.locals.mcpServer;
      try {
        await mcp.handleRequest(req, res, endpoint);
      } catch (error) {
        console.error(`MCP GET request error (${path}):`, error);
        if (!res.headersSent) res.status(500).send('Error establishing stream');
      }
    });
    app.delete(path, async (req, res) => {
      const mcp: MCPServer = app.locals.mcpServer;
      try {
        await mcp.handleRequest(req, res, endpoint);
      } catch (error) {
        console.error(`MCP DELETE request error (${path}):`, error);
        if (!res.headersSent) res.status(500).send('Error terminating session');
      }
    });
  };

  // Wing-aware henchery endpoint: /mcp/henchery/:wingName
  // The wing name from the URL path is stored per-session and injected into ActionContext.
  const mountHencheryEndpoint = (path: string) => {
    app.post(path, async (req, res) => {
      const mcp: MCPServer = app.locals.mcpServer;
      const wingName = req.params.wingName;
      try {
        await mcp.handleRequest(req, res, 'henchery', wingName);
      } catch (error) {
        console.error(`MCP POST request error (${path}):`, error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            id: req.body?.id,
            error: { code: -32603, message: error instanceof Error ? error.message : 'Internal error' }
          });
        }
      }
    });
    app.get(path, async (req, res) => {
      const mcp: MCPServer = app.locals.mcpServer;
      const wingName = req.params.wingName;
      try {
        await mcp.handleRequest(req, res, 'henchery', wingName);
      } catch (error) {
        console.error(`MCP GET request error (${path}):`, error);
        if (!res.headersSent) res.status(500).send('Error establishing stream');
      }
    });
    app.delete(path, async (req, res) => {
      const mcp: MCPServer = app.locals.mcpServer;
      const wingName = req.params.wingName;
      try {
        await mcp.handleRequest(req, res, 'henchery', wingName);
      } catch (error) {
        console.error(`MCP DELETE request error (${path}):`, error);
        if (!res.headersSent) res.status(500).send('Error terminating session');
      }
    });
  };

  mountHencheryEndpoint('/mcp/henchery/:wingName');
  // Keep the legacy route for backwards compatibility (no wing name in URL)
  mountMcpEndpoint('/mcp/henchery', 'henchery');
  mountMcpEndpoint('/mcp/lair', 'lair');
  mountMcpEndpoint('/mcp/conductor', 'conductor');
  mountMcpEndpoint('/mcp/throne', 'throne');

  // Serve static files from throne room dist at root
  // Note: In bundled output, __dirname will be the dist/ folder
  // Throne-room UI is packaged at dist/throne-room during build
  const throneRoomDist = path.resolve(__dirname, './throne-room');
  app.use(express.static(throneRoomDist));

  // API endpoint for secretary status
  app.get('/api/secretary/status', (_req, res) => {
    res.json(secretary.getStatus());
  });

  // List all files in a wing's work/local repo (for FilePath mission inputs)
  // Returns relative paths from the repo root, skipping build/tooling noise directories
  const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.nx', '.vite', 'coverage', '_uploads', '.claude']);

  app.get('/api/files/list', async (req, res) => {
    try {
      const { wingName } = req.query as { wingName?: string };
      const wingManager = app.locals.wingManager as WingManager | undefined;
      if (!wingManager || !wingName) {
        res.status(400).json({ error: 'wingName is required' });
        return;
      }
      const wing = wingManager.getWing(wingName);
      if (!wing) {
        res.status(404).json({ error: `Wing not found: ${wingName}` });
        return;
      }
      let workArea;
      try {
        workArea = await wing.workAreaLocal();
      } catch {
        res.status(404).json({ error: `Wing ${wingName} has no work/local worktree` });
        return;
      }
      const movement = await workArea.activeMovement();
      const matches = await movement.files.glob('**/*', [...SKIP_DIRS]);
      const files = matches.filter((m) => m.kind === 'file').map((m) => m.name).sort();
      res.json({ files });
    } catch (error) {
      console.error('[server] File list error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'List failed' });
    }
  });

  // Live quality state for the Throne Room quality panel (qq001002). Emits
  // the current snapshot on connect, then re-polls the (already cached,
  // synchronous) watcher state and pushes again only when it actually
  // changed — cheap enough to poll per-connection rather than needing a
  // shared broadcast/event-bus (see MCPServer.getQualityStreamPayload's own
  // doc comment for why there's no push-on-change source to subscribe to
  // instead).
  const QUALITY_STREAM_POLL_MS = 1000;
  app.get('/api/quality/stream', (_req, res) => {
    const mcpServer = app.locals.mcpServer as MCPServer;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    let lastSent: string | undefined;
    const sendIfChanged = () => {
      const json = JSON.stringify(mcpServer.getQualityStreamPayload());
      if (json === lastSent) return;
      lastSent = json;
      res.write(`data: ${json}\n\n`);
    };
    sendIfChanged();
    const interval = setInterval(sendIfChanged, QUALITY_STREAM_POLL_MS);
    res.on('close', () => clearInterval(interval));
  });

  // SPA fallback: serve index.html for any non-API, non-static route so client-side routing works
  app.get('*', (_req, res) => {
    const indexHtml = path.join(throneRoomDist, 'index.html');
    res.sendFile(indexHtml, (err) => {
      if (err) res.status(404).send('Not found');
    });
  });

  // Error handling middleware
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}