import { FF } from '@minions/feature-flags';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Sandbox, Directory, Lair, File as FileNode, Wing } from '@minions/file-store';
import { createDiskSandbox } from '@minions/file-store';
import type { Gadget, GadgetContext } from '@minions/gadgets';
import { McpServerCore, ALL_ENDPOINTS, type McpRequestExtra, type SessionInfo } from '@minions/mcp-server-core';
import type { ToolName } from './ToolRegistry.js';
import { isKnownTool, EndpointName, ENDPOINT_TOOL_SETS } from './ToolRegistry.js';
import { getLairState } from './lairStateService.js';
import { createWing, deleteWing, updateWingWork, setWingTrunk, reprovisionWingHooks, syncWing } from '../wings/WingService.js';
import { listExperiments, getExperiment, createExperiment, assignWing, unassignWing, selectWinner, resolveExperiment } from '../experiments/ExperimentsService.js';
import { listArchives, addArchive, removeArchive } from '../archives/ArchiveService.js';
import {
  spawnMinion,
  listMinions,
  getMinionHistory,
  getMinionInteractions,
  getMinionInteractionDetail,
  killMinion,
  respawnExecutor,
  MinionStatus,
  MissionService,
} from '@minions/minions-runtime-core';
import type { MinionManager, MinionClient } from '@minions/minions-runtime-core';
import type { WingManager } from '../wings/WingManager.js';
import type { ProductionHatchery } from '@minions/hatchery';
import { ClosetMissionLoader } from '@minions/conductor';
import type { MissionSummary_ } from '@minions/mcp-types';
import { CabinetQuestionBridge } from '../missions/CabinetQuestionBridge.js';
import { getQuestionQueue } from '../questions/QuestionQueue.js';
import { buildQualityStreamPayload, type IQualityWatcher, type QualityStreamPayload, type QualityWatcherFactory } from '@minions/quality-watcher';
import { QualityWatcherProcessClient, type CrashInfo, type RespawnInfo } from '../quality/QualityWatcherProcessClient.js';
import { QualityWedgeBackstop } from '../quality/QualityWedgeBackstop.js';
import { CommitCoordinator } from '@minions/movement-branching';
import { GitCoordinationState } from '@minions/file-store';
import { KeyedQueue } from '@minions/scheduling';
import type { ActionGroupDef } from '@minions/mcp-types';
import { readAccessoriesFile, readClosetCostumes, resolveExternalServers } from '@minions/wardrobe';
import { McpProxy, SERVER_NAME_SEPARATOR } from './McpProxy.js';
import { PRODUCT_NAME, buildServerInstructions } from './serverIdentity.js';
import type { SharedBrowserProvider } from '../browser/SharedBrowserService.js';
import type { RegistryConfig } from '../registry/types.js';
import { installFromRegistry } from '../registry/installer.js';
import { publishDirect, publishViaApi } from '../registry/PublishService.js';
import { createWingActivityTracker } from './createWingActivityTracker.js';

/**
 * How often `tools/call` sends a progress-notification heartbeat while a
 * handler is running, in addition to one fired immediately on receipt. Kept
 * well under the streamable-HTTP idle timeout (5 min default) and the
 * auto-backgrounding threshold (2 min default) so a slow tool never looks dead.
 */
const TOOL_CALL_HEARTBEAT_INTERVAL_MS = 90_000;

export interface ServerIdentityInput {
  isDevMode: boolean;
  version: string;
  /** Wing this dev instance runs from — irrelevant/omitted in production. */
  wingName?: string;
}

/** Per-session metadata this cabinet attaches to every MCP session, opaque to `McpServerCore`. */
interface SessionMeta {
  clientName: string;
  wingName?: string;
}

/**
 * Wrapper class for MCP SDK Server with StreamableHTTP transport.
 * Composes `@minions/mcp-server-core`'s `McpServerCore` for the generic
 * session/transport/action-group mounting mechanics, and supplies every
 * minions-specific behavior (built-in tool dispatch, gadget/proxy fallback,
 * per-group action-context extension, wing-scoped state) via its hooks.
 */
export class MCPServer {
  private readonly core: McpServerCore<SessionMeta>;
  private readonly gadgetHandlers = new Map<string, { costumeName: string; gadget: Gadget }>();
  private wingManager?: WingManager;
  private lairRoot?: string;
  private lair?: Lair;
  /** Whether this cabinet is a wing's dev instance (HMR) vs. a production build. */
  private isDevMode = false;
  /** Real release version in production; short git commit sha in dev. */
  private version = 'unknown';
  /** The wing this dev instance is running from — unset in production. */
  private wingName?: string;
  private minionManager?: MinionManager;
  private productionHatchery?: ProductionHatchery;
  private sandbox?: Sandbox;
  private wingsDir?: Directory;
  private missionService?: MissionService;
  /** Proxy for external MCP servers declared by active costume accessories */
  private readonly proxy = new McpProxy();
  /** Cached mission list per wing — populated on first request, cleared on costume install */
  private readonly missionListCache = new Map<string, MissionSummary_[]>();
  /** Optional module loader for TypeScript mission files (set by dev server's ViteNodeRunner) */
  private moduleLoader?: (url: string) => Promise<Record<string, unknown>>;
  /** Named costume registries — populated from cabinet.config.json */
  private registries: Record<string, RegistryConfig> = {};
  /** Default registry name to use when none is specified */
  private defaultRegistry = 'official';
  /** GitHub OAuth token for publishing (from githubAuth in cabinet.config.json or GITHUB_TOKEN env) */
  private githubToken: string | null = process.env['GITHUB_TOKEN'] ?? null;
  /** GitHub username of the authenticated user */
  private githubConnectedAs: string | null = null;
  /**
   * One continuously-watching quality watcher per wing, started/stopped in
   * step with wing sessions (see wingSessions) — a `WingQualityWatcher`
   * (in-process) or, behind `HIGHER_PERF_QUALITY_WATCHER`, a
   * `RemoteQualityWatcher` client talking to the separate
   * quality-watcher-process (see docs/design/quality-watcher-process-redesign.md).
   */
  private readonly qualityWatchers = new Map<string, IQualityWatcher>();
  /**
   * Lazily spawns/owns the shared quality-watcher-process child, when
   * `HIGHER_PERF_QUALITY_WATCHER` is on. Constructor-injectable (defaults to
   * a real one) purely so tests can drive Tier 3's crash/respawn behavior
   * against a fake spawned process instead of a real OS process — see
   * `QualityWatcherProcessClient.test.ts`'s own `fakeSpawnedProcess`.
   */
  private readonly qualityWatcherProcessClient: QualityWatcherProcessClient;
  /**
   * Tier 2 of the three-tier resilience design (see
   * docs/design/quality-watcher-process-redesign.md) — an independent
   * cabinet-side backstop over every wing's live `qualityWatchers` state,
   * started unconditionally in the constructor. Its own periodic check is a
   * no-op with nothing to report (no `RemoteQualityWatcher` yet running, or
   * `HIGHER_PERF_QUALITY_WATCHER` off entirely — `qualityWatchers` then only
   * ever holds `WingQualityWatcher` instances, which it ignores), so
   * starting it unconditionally never wakes the watcher process on its own.
   */
  private readonly qualityWedgeBackstop: QualityWedgeBackstop;
  /** Wing names snapshotted at failure time (see `invalidateQualityWatchersAfterFailure`) — held until the respawn resolves and they're actually re-attached. */
  private wingNamesPendingReattach: string[] = [];
  /**
   * This cabinet's own long-lived per-worktree commit-debounce state (see
   * `CommitCoordinator` in `@minions/movement-branching`) — one instance for
   * the process's whole lifetime, handed to every `movement commit` call via
   * `ActionContext.commitCoordinator`, so a retried commit for the same
   * worktree joins whichever attempt is already running instead of racing a
   * second one against it.
   */
  private readonly commitCoordinator = new CommitCoordinator();
  /**
   * This cabinet's own long-lived git write-serialization/fetch-cache state
   * (see `GitCoordinationState` in `@minions/file-store`) — one instance for
   * the process's whole lifetime. Public so `server.ts` can thread it into
   * every `createDiskSandbox` call it makes for this cabinet, instead of
   * each sandbox implicitly falling back to the library's own hidden
   * module-level default.
   */
  readonly gitCoordination = new GitCoordinationState();
  /**
   * This cabinet's own long-lived lock serializing compound operations
   * against a lair-level conductor mirror worktree (see `mirrorOpLock` in
   * `@minions/repo-perspective`) — one instance for the process's whole
   * lifetime, instead of falling back to the library's own hidden
   * module-level default. Handed into every `plan`/`movement` action's
   * `ActionContext.mirrorOpLock`, but every plan-mirror write is
   * self-locking (`Mirror.apply()`'s own CAS), so neither action group
   * actually reads it back off `ctx` — that plumbing is harmless, unread
   * dead weight.
   */
  readonly mirrorOpLock = new KeyedQueue();
  /**
   * Constructs every real `IQualityWatcher` this server hands out — the one
   * seam between this class (which only ever depends on `IQualityWatcher`)
   * and `@minions/quality-watcher`'s concrete, software-development-domain
   * implementations. Injected from `server.ts`'s composition root (see
   * `productionQualityWatcherFactory.ts`), the same
   * `IHatchery`/`ProductionHatchery` shape `productionHatchery` uses above.
   * Undefined in a checkout that doesn't carry that composition file (e.g. a
   * `minions-platform`-only extraction) — every caller below already
   * tolerates "no watcher available" for other reasons (a watcher failing to
   * start, `HACK_OFF_QUALITY_CHECKS`), so a missing factory degrades the
   * same way.
   */
  private qualityWatcherFactory?: QualityWatcherFactory;
  /**
   * The single place MCP session lifecycle is registered — the core's
   * session-initialized/session-closed hooks call only this, and it's the
   * sole owner of the per-wing inactivity debounce timer. Guards just react
   * to what it tells them.
   */
  private readonly wingSessions = createWingActivityTracker({
    warmQualityWatcher: (wingName) => this.warmQualityWatcher(wingName),
    coolQualityWatcher: (wingName) => this.coolQualityWatcher(wingName),
  });

  constructor(qualityWatcherProcessClient: QualityWatcherProcessClient = new QualityWatcherProcessClient()) {
    // Tools and dependencies are set up via initialize() and registerTool()
    this.qualityWatcherProcessClient = qualityWatcherProcessClient;
    this.qualityWatcherProcessClient.onCrash((info) => this.invalidateQualityWatchersAfterFailure(info));
    this.qualityWatcherProcessClient.onRespawn((info) => this.reattachWingsAfterQualityWatcherRespawn(info));
    this.qualityWedgeBackstop = new QualityWedgeBackstop(
      () => this.qualityWatchers,
      () => this.qualityWatcherProcessClient.ensureStarted(),
    );
    this.qualityWedgeBackstop.start();

    this.core = new McpServerCore<SessionMeta>(
      {
        name: PRODUCT_NAME,
        version: () => this.version,
        buildInstructions: () => buildServerInstructions({
          isDevMode: this.isDevMode,
          lairName: this.lair?.name,
          wingName: this.wingName,
        }),
        heartbeatIntervalMs: TOOL_CALL_HEARTBEAT_INTERVAL_MS,
      },
      {
        buildActionContext: (meta) => this.buildActionContext(meta),
        extendActionContext: (groupName, baseContext, extra) => this.extendActionContext(groupName, baseContext, extra),
        checkToolAccess: (toolName, sessionEndpoint) => this.checkToolAccess(toolName, sessionEndpoint as EndpointName),
        handleOtherTool: (name, args, extra, server) => this.handleOtherTool(name, args, extra, server),
        resolveTools: (endpoint, meta, sessionId, staticTools) =>
          this.resolveTools(endpoint as EndpointName, meta, sessionId, staticTools),
        inferInterestFromTool: (toolName) => this.inferInterestFromTool(toolName),
        onSessionInitialized: (sid, info) => this.onSessionInitialized(sid, info),
        onSessionClosed: (sid) => this.onSessionClosed(sid),
      },
    );
  }

  /**
   * Tier 3's cache-invalidation step: fires synchronously the moment
   * `QualityWatcherProcessClient` detects the whole process has failed —
   * crashed (exited) or been declared hung (missed too many health checks)
   * — *before* any respawn attempt, let alone one succeeding. Every
   * `RemoteQualityWatcher` this held was talking to the now-dead/hung
   * process at a base URL nothing will usefully answer at again, so this
   * drops them immediately rather than waiting for the respawn to resolve
   * (which can take up to the client's own startup timeout). Any
   * `quality_status` call or session warm-up landing in that window now
   * finds no cached watcher, takes the "construct new" branch in
   * `getOrCreateQualityWatcher`, and calls
   * `qualityWatcherProcessClient.ensureStarted()` — which joins the *same*
   * in-flight respawn already underway (single-flight memoization), rather
   * than either hitting the dead process or racing a second spawn.
   *
   * Only wings whose watcher was actually `isRunning()` at failure time are
   * remembered for re-attachment — `qualityWatchers` also accumulates
   * long-cooled, session-inactive wings (`coolQualityWatcher` stops them but
   * never removes them from the map), and there's no reason to proactively
   * rewarm a wing nothing is currently using.
   */
  private invalidateQualityWatchersAfterFailure(info: CrashInfo): void {
    this.wingNamesPendingReattach = [...this.qualityWatchers.entries()]
      .filter(([, watcher]) => watcher.isRunning())
      .map(([wingName]) => wingName);
    this.qualityWatchers.clear();
    console.error(
      `[MCPApi] quality-watcher-process failed (${info.reason}) — cleared all cached watchers; ` +
        `${this.wingNamesPendingReattach.length} previously-active wing(s) queued for re-attach once it respawns.`
    );
  }

  /**
   * Tier 3's re-attach step: once `QualityWatcherProcessClient` confirms a
   * replacement process is listening, reconstruct one watcher per wing
   * snapshotted by `invalidateQualityWatchersAfterFailure` via the normal
   * `getOrCreateQualityWatcher` path (now resolving against the freshly-
   * spawned process's new base URL) — reusing `warmQualityWatcher`'s
   * existing fire-and-forget-with-logging shape so one wing failing to
   * re-attach doesn't block the rest.
   */
  private reattachWingsAfterQualityWatcherRespawn(info: RespawnInfo): void {
    const wingNames = this.wingNamesPendingReattach;
    this.wingNamesPendingReattach = [];
    console.error(
      `[MCPApi] quality-watcher-process respawned (${info.reason}) at ${info.baseUrl} — ` +
        `re-attaching ${wingNames.length} previously-active wing(s): ${wingNames.join(', ') || '(none were active)'}.`
    );
    for (const wingName of wingNames) {
      this.warmQualityWatcher(wingName);
    }
  }

  /** Set the registry configuration (called from server.ts after reading cabinet.config.json) */
  setRegistries(registries: Record<string, RegistryConfig>, defaultRegistry: string): void {
    this.registries = registries;
    this.defaultRegistry = defaultRegistry;
  }

  /**
   * Provide the shared verification browser to the external-MCP proxy so that
   * costume servers flagged `sharedBrowser: true` (e.g. browser-verify's
   * chrome-devtools-mcp) attach to the lair's shared Chrome. Called from server.ts
   * once the service singleton exists.
   */
  setSharedBrowser(provider: SharedBrowserProvider): void {
    this.proxy.setSharedBrowser(provider);
  }

  /** Set the GitHub auth token (called from server.ts when auth state changes) */
  setGithubAuth(token: string | null, connectedAs: string | null): void {
    this.githubToken = token ?? process.env['GITHUB_TOKEN'] ?? null;
    this.githubConnectedAs = connectedAs;
  }

  /**
   * Initialize dependencies needed for tools
   */
  initialize(
    wingManager?: WingManager,
    lairRoot?: string,
    lair?: Lair,
    minionManager?: MinionManager,
    productionHatchery?: ProductionHatchery,
    sandbox?: Sandbox,
    wingsDir?: Directory,
    moduleLoader?: (url: string) => Promise<Record<string, unknown>>,
    identity?: ServerIdentityInput,
    qualityWatcherFactory?: QualityWatcherFactory
  ): void {
    this.wingManager = wingManager;
    this.lairRoot = lairRoot;
    this.qualityWatcherFactory = qualityWatcherFactory;
    this.lair = lair;
    this.minionManager = minionManager;
    this.productionHatchery = productionHatchery;
    this.sandbox = sandbox;
    this.wingsDir = wingsDir;
    this.moduleLoader = moduleLoader;
    this.isDevMode = identity?.isDevMode ?? false;
    this.version = identity?.version ?? 'unknown';
    this.wingName = identity?.wingName;

    // Initialize mission service if hatchery is available
    // Pass broadcast function to push events to connected session clients
    if (productionHatchery) {
      this.missionService = new MissionService(
        productionHatchery,
        new CabinetQuestionBridge(),
        (data) => this.broadcast(data),
        this.moduleLoader
      );
    }

    // Wire up question queue broadcast for real-time question notifications
    const questionQueue = getQuestionQueue();
    questionQueue.setBroadcast((event) => this.broadcast(event));

    // Wire up minion manager broadcast for real-time minion notifications
    if (minionManager) {
      minionManager.setBroadcast((event) => this.broadcast(event));
    }
  }

  /**
   * Mount an ActionGroupDef as a single MCP tool.
   * The framework assembles the schema and description; the cabinet supplies
   * only the def, which endpoints should expose the tool, and optionally which
   * endpoints expose each individual action within the group.
   *
   * @param actionEndpoints  Optional per-action endpoint restrictions. When provided for an
   *   action, that action is only documented and callable from the listed endpoints (which
   *   must be a subset of the group-level endpoints). When omitted for an action, the
   *   action inherits the group-level endpoint set.
   */
  mountActionGroup<TLair = unknown>(
    def: ActionGroupDef<Record<string, { params: unknown; result: unknown }>, TLair>,
    endpoints: EndpointName[] = ['henchery'],
    actionEndpoints?: Partial<Record<string, EndpointName[]>>,
  ): void {
    this.core.mountActionGroup(def, endpoints, actionEndpoints);
  }

  /** Build the base `ActionContext` shared by every mounted action group's dispatch for this call. */
  private buildActionContext(meta: SessionMeta | undefined): { lair: Sandbox; wingName?: string } {
    if (!this.sandbox) throw new Error('Sandbox not initialized');
    return { lair: this.sandbox, wingName: meta?.wingName };
  }

  /** Extend the base action context with the extra fields specific action groups need. */
  private extendActionContext(groupName: string, baseContext: unknown, extra: McpRequestExtra): unknown {
    const base = baseContext as { lair: Sandbox; wingName?: string };
    switch (groupName) {
      case 'ask':
        return { ...base, sessionId: extra.sessionId };
      case 'movement':
        return {
          ...base,
          getQualityWatcher: (wn: string) => this.getOrCreateQualityWatcher(wn),
          pauseQualityWatcher: (wn: string) => this.pauseQualityWatcher(wn),
          resumeQualityWatcher: (wn: string) => this.resumeQualityWatcher(wn),
          commitCoordinator: this.commitCoordinator,
          mirrorOpLock: this.mirrorOpLock,
          findExperimentByTrunk: async (trunk: string) => {
            if (!this.lair) return null;
            const experiments = await listExperiments(this.lair);
            const experiment = experiments.find((e) => e.variations.some((v) => v.trunkBranch === trunk));
            return experiment ? { id: experiment.id, status: experiment.status } : null;
          },
          onExperimentPromoted: async (trunk: string) => {
            if (!this.lair || !this.wingManager) return;
            const experiments = await listExperiments(this.lair);
            const experiment = experiments.find((e) => e.variations.some((v) => v.trunkBranch === trunk));
            if (experiment) await resolveExperiment(this.lair, this.wingManager, experiment.id);
          },
        };
      case 'plan':
        return { ...base, mirrorOpLock: this.mirrorOpLock };
      case 'costumes':
        return {
          ...base,
          lairRootPath: this.lairRoot,
          getWing: (wn: string) => this.wingManager?.getWing(wn),
          onCostumeInstalled: (wn?: string) => {
            if (wn) this.missionListCache.delete(wn);
            else this.missionListCache.clear();
          },
          registries: this.registries,
          defaultRegistry: this.defaultRegistry,
          installFromRegistry: (
            name: string,
            version: string,
            registry: RegistryConfig
          ) => installFromRegistry(this.lairRoot ?? '', name, version, registry),
          publishCostume: async (
            name: string,
            version: string,
            registry: RegistryConfig,
            distDir: string,
            dryRun = false
          ) => {
            const token = this.githubToken;
            if (!token) {
              throw new Error(
                'No GitHub token available. Connect via the registry auth flow first, or set GITHUB_TOKEN env var.'
              );
            }
            if (registry.publishApi) {
              return publishViaApi({
                name, version, distDir,
                apiUrl: registry.publishApi,
                githubToken: token,
                publisher: this.githubConnectedAs ?? undefined,
                dryRun,
              });
            }
            if (registry.publishDirect) {
              return publishDirect({
                name, version, distDir,
                indexRepo: registry.publishDirect.indexRepo,
                githubToken: token,
                publisher: this.githubConnectedAs ?? undefined,
                dryRun,
              });
            }
            throw new Error(
              'Registry has no publish path configured. ' +
              'Add publishApi (Worker URL) or publishDirect.indexRepo (GitHub repo) to the registry config.'
            );
          },
        };
      default:
        return base;
    }
  }

  /** Enforce endpoint-level access control for built-in tools (action groups enforce their own via `mountActionGroup`'s endpoint sets). */
  private checkToolAccess(toolName: string, sessionEndpoint: EndpointName): void {
    if (sessionEndpoint !== ALL_ENDPOINTS && isKnownTool(toolName)) {
      const allowed = ENDPOINT_TOOL_SETS[sessionEndpoint] as readonly string[];
      if (!allowed.includes(toolName)) {
        throw new Error(`Tool '${toolName}' is not available on the '${sessionEndpoint}' endpoint`);
      }
    }
  }

  /**
   * Combine active-costume gating of gadget tools with proxy tools from
   * connected external MCP servers into the final `tools/list` result — done
   * together so both share one `resolveActiveCostumes` read per request
   * instead of two.
   */
  private async resolveTools(
    endpoint: EndpointName,
    meta: SessionMeta | undefined,
    sessionId: string | undefined,
    staticTools: Tool[],
  ): Promise<Tool[]> {
    let activeCostumes: Set<string> | undefined;
    let proxyTools: Tool[] = [];
    if (endpoint === 'henchery' && sessionId) {
      const wingName = meta?.wingName;
      if (wingName) {
        activeCostumes = await this.resolveActiveCostumes(wingName);
        proxyTools = await this.collectProxyTools(activeCostumes);
      }
    }
    const filtered = activeCostumes ? this.filterGadgetsByActiveCostumes(staticTools, activeCostumes) : staticTools;
    return [...filtered, ...proxyTools];
  }

  /** Exclude gadgets whose costume isn't in `activeCostumes`. Non-gadget tools (built-ins) pass through unchanged. */
  private filterGadgetsByActiveCostumes(tools: Tool[], activeCostumes: Set<string>): Tool[] {
    return tools.filter((t) => {
      const gadgetEntry = this.gadgetHandlers.get(t.name);
      if (!gadgetEntry) return true;
      return activeCostumes.has(gadgetEntry.costumeName);
    });
  }

  /**
   * Handle a `tools/call` for a name that isn't a mounted action group:
   * tools proxied from a connected external MCP server, file-based gadgets,
   * and every built-in tool.
   */
  private async handleOtherTool(name: string, args: Record<string, unknown>, extra: McpRequestExtra, server: Server): Promise<CallToolResult> {
    // Route proxy tools: names containing '__' that map to a connected external server
    if (!isKnownTool(name) && name.includes(SERVER_NAME_SEPARATOR)) {
      const separatorIndex = name.indexOf(SERVER_NAME_SEPARATOR);
      const serverName = name.slice(0, separatorIndex);
      if (this.proxy.connectedServers.has(serverName)) {
        const result = await this.proxy.callTool(serverName, name, args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
    }

    // Check file-based gadgets as fallback for non-built-in tools
    if (!isKnownTool(name)) {
      const gadgetEntry = this.gadgetHandlers.get(name);
      if (gadgetEntry) {
        const ctx: GadgetContext = {
          getWing: (wingName: string) => this.wingManager?.getWing(wingName),
          lairRoot: this.lairRoot ?? '',
        };
        const result = await gadgetEntry.gadget.execute(ctx, args);
        if (!result.success) {
          throw new Error(result.error);
        }
        return {
          content: [
            { type: 'text', text: JSON.stringify(result.result) }
          ]
        };
      }
      throw new Error(`Unknown tool: ${name}`);
    }

    // Type-safe switch with exhaustiveness checking
    const toolName = name as ToolName;
    switch (toolName) {
      case 'lair_get_state': {
        if (!this.wingManager) {
          throw new Error('Wing manager not initialized');
        }
        const state = await getLairState(this.wingManager);
        return {
          content: [
            { type: 'text', text: JSON.stringify(state, null, 2) }
          ]
        };
      }

      case 'wings': {
        if (!this.wingManager) {
          throw new Error('Wing manager not initialized');
        }
        const { action: wingsAction } = args;
        switch (wingsAction) {
          case 'create': {
            const { name: wingName, workLocalRepo, extraWork, trunk } = args;
            const result = await createWing(
              this.wingManager,
              wingName as string,
              workLocalRepo as string,
              extraWork as Record<string, { repo: string; branch: string; subdir?: string }> | undefined,
              trunk as string | undefined
            );
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          }
          case 'set-trunk': {
            const { name: wingName, trunk } = args;
            const result = await setWingTrunk(this.wingManager, wingName as string, trunk as string | null);
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          }
          case 'delete': {
            const { name: wingName } = args;
            const result = await deleteWing(this.wingManager, wingName as string);
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          }
          case 'update': {
            const { name: wingName, addWork, removeWork } = args;
            const result = await updateWingWork(
              this.wingManager,
              wingName as string,
              addWork as Record<string, { repo: string; branch: string; subdir?: string }> | undefined,
              removeWork as string[] | undefined
            );
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          }
          case 'reprovision-hooks': {
            const { name: wingName } = args;
            const result = await reprovisionWingHooks(this.wingManager, wingName as string | undefined);
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          }
          case 'sync-wing': {
            const { name: wingName } = args;
            const result = await syncWing(this.wingManager, wingName as string | undefined);
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          }
          default:
            throw new Error(`Unknown wings action: ${wingsAction}`);
        }
      }

      case 'experiments': {
        if (!this.lair) {
          throw new Error('Lair not initialized');
        }
        const { action: experimentsAction } = args;
        const sessionEndpoint = this.core.getSessionEndpoint(extra.sessionId) as EndpointName;
        if (experimentsAction === 'select-winner' && sessionEndpoint !== ALL_ENDPOINTS && sessionEndpoint !== 'throne') {
          throw new Error(`Action 'select-winner' of tool 'experiments' is not available on the '${sessionEndpoint}' endpoint`);
        }
        switch (experimentsAction) {
          case 'list': {
            const { repo } = args;
            const experiments = await listExperiments(this.lair, repo as string | undefined);
            return { content: [{ type: 'text', text: JSON.stringify({ action: 'list', experiments }) }] };
          }
          case 'get': {
            const { id, repo } = args;
            const experiment = await getExperiment(this.lair, id as string, repo as string | undefined);
            return { content: [{ type: 'text', text: JSON.stringify({ action: 'get', experiment }) }] };
          }
          case 'create': {
            const { id, variations, repo } = args;
            const experiment = await createExperiment(
              this.lair,
              id as string,
              variations as Array<{ slug: string }>,
              repo as string | undefined
            );
            return { content: [{ type: 'text', text: JSON.stringify({ action: 'create', experiment }) }] };
          }
          case 'assign-wing': {
            if (!this.wingManager) throw new Error('Wing manager not initialized');
            const { id, slug, wingName, repo } = args;
            const experiment = await assignWing(
              this.lair,
              this.wingManager,
              id as string,
              slug as string,
              wingName as string,
              repo as string | undefined
            );
            return { content: [{ type: 'text', text: JSON.stringify({ action: 'assign-wing', experiment }) }] };
          }
          case 'unassign-wing': {
            if (!this.wingManager) throw new Error('Wing manager not initialized');
            const { id, slug, wingName, repo } = args;
            const experiment = await unassignWing(
              this.lair,
              this.wingManager,
              id as string,
              slug as string,
              wingName as string,
              repo as string | undefined
            );
            return { content: [{ type: 'text', text: JSON.stringify({ action: 'unassign-wing', experiment }) }] };
          }
          case 'select-winner': {
            if (!this.wingManager) throw new Error('Wing manager not initialized');
            const { id, winnerSlug, repo } = args;
            const experiment = await selectWinner(this.lair, this.wingManager, id as string, winnerSlug as string, repo as string | undefined);
            return { content: [{ type: 'text', text: JSON.stringify({ action: 'select-winner', experiment }) }] };
          }
          default:
            throw new Error(`Unknown experiments action: ${experimentsAction}`);
        }
      }

      case 'archives': {
        if (!this.lair) {
          throw new Error('Lair not initialized');
        }
        const { action: archivesAction } = args;
        switch (archivesAction) {
          case 'list': {
            const result = await listArchives(this.lair);
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          }
          case 'add': {
            const { type, name: archiveName, url, auth, branch } = args;
            const cloneAuth = auth as { username?: string; token: string } | undefined;
            const result = await addArchive(
              this.lair,
              type as 'work' | 'info' | 'private',
              archiveName as string,
              url as string | undefined,
              cloneAuth,
              branch as string | undefined
            );
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          }
          case 'remove': {
            const { type, name: archiveName } = args;
            const result = await removeArchive(this.lair, type as 'work' | 'info' | 'private', archiveName as string);
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          }
          default:
            throw new Error(`Unknown archives action: ${archivesAction}`);
        }
      }

      case 'minions': {
        const { action: minionsAction } = args;
        switch (minionsAction) {
          case 'spawn': {
            if (!this.minionManager || !this.productionHatchery) {
              throw new Error('Minion manager or hatchery not initialized');
            }
            const { client, wingName, agentPrompt } = args;
            const result = await spawnMinion(
              this.minionManager,
              this.productionHatchery,
              client as MinionClient,
              wingName as string,
              this.lairRoot,
              agentPrompt as string | undefined
            );
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          }
          case 'list': {
            if (!this.minionManager) {
              throw new Error('Minion manager not initialized');
            }
            const { wingName } = args;
            const result = listMinions(this.minionManager, wingName as string | undefined);
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          }
          case 'get_history': {
            if (!this.minionManager) {
              throw new Error('Minion manager not initialized');
            }
            const { minionId } = args;
            const result = getMinionHistory(this.minionManager, minionId as string);
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          }
          case 'get_interactions': {
            if (!this.minionManager) {
              throw new Error('Minion manager not initialized');
            }
            const { minionId } = args;
            const result = getMinionInteractions(this.minionManager, minionId as string);
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          }
          case 'get_interaction_detail': {
            if (!this.minionManager) {
              throw new Error('Minion manager not initialized');
            }
            const { minionId, interactionId } = args;
            const result = getMinionInteractionDetail(this.minionManager, minionId as string, interactionId as string);
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          }
          case 'send_message': {
            if (!this.minionManager) {
              throw new Error('Minion manager not initialized');
            }
            const { minionId, message } = args;
            const minionIdStr = minionId as string;
            const messageStr = message as string;

            const minion = this.minionManager.get(minionIdStr);
            if (!minion) {
              throw new Error(`Minion not found: ${minionId}`);
            }

            if (!minion.executor) {
              if (minion.status === MinionStatus.Dead) {
                throw new Error('Cannot send message to dead minion');
              }
              // Minion is idle with no active process - respawn a new one
              if (!this.productionHatchery || !this.minionManager) {
                throw new Error('Hatchery or minion manager not initialized');
              }
              await respawnExecutor(minion, this.productionHatchery, this.minionManager, this.lairRoot);
            }

            if (!minion.executor) {
              throw new Error('Failed to establish executor for minion');
            }

            // Capture executor reference for use in callbacks
            const executor = minion.executor;

            // Set up event-driven streaming via MCP SDK
            const turnCompletePromise = new Promise<void>((resolve, reject) => {
              const contentListener = async (block: unknown) => {
                try {
                  // Stream content blocks via MCP SDK logging
                  await server.sendLoggingMessage({
                    level: 'info',
                    data: {
                      type: 'content',
                      minionId,
                      content: block,
                      timestamp: Date.now()
                    }
                  }, extra.sessionId);
                } catch (err) {
                  console.error('[MCPApi] Error streaming content:', err);
                }
              };

              const turnEndedListener = () => {
                console.log(`[MCPApi] Minion ${minionId} turn ended`);
                resolve();
              };

              const errorListener = (error: Error) => {
                console.error(`[MCPApi] Minion ${minionId} error:`, error);
                reject(error);
              };

              // Store listeners for cleanup
              const tempListeners = {
                content: contentListener,
                turn_ended: turnEndedListener,
                error: errorListener
              };

              // Attach temporary listeners for this request
              executor.on('content', contentListener);
              executor.on('turn_ended', turnEndedListener);
              executor.on('error', errorListener);

              (minion as unknown as { _tempMCPListeners: typeof tempListeners })._tempMCPListeners = tempListeners;
            });

            try {
              // Update status and send message
              this.minionManager.updateStatus(minionIdStr, MinionStatus.Working);

              // Send the message (this triggers the minion to start processing)
              if (typeof minion.executor.sendMessage === 'function') {
                await minion.executor.sendMessage(messageStr);
              } else {
                throw new Error('Executor does not support sendMessage');
              }

              // Add to message history
              const timestamp = Date.now();
              minion.messageHistory.push({
                role: 'user',
                content: messageStr,
                timestamp
              });

              // Stream user message notification
              await server.sendLoggingMessage({
                level: 'info',
                data: {
                  type: 'user_message',
                  minionId,
                  content: message,
                  timestamp
                }
              }, extra.sessionId);

              // Wait for turn to complete (blocks until turn_ended or error)
              await turnCompletePromise;

              // Return final success result
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      status: 'completed',
                      minionId
                    })
                  }
                ]
              };
            } catch (error) {
              // Stream error notification
              await server.sendLoggingMessage({
                level: 'error',
                data: {
                  type: 'error',
                  minionId,
                  error: (error as Error).message,
                  timestamp: Date.now()
                }
              }, extra.sessionId);

              throw error;
            } finally {
              // Clean up temporary listeners to prevent memory leaks
              type TempListeners = {
                content: (block: unknown) => Promise<void>;
                turn_ended: () => void;
                error: (error: Error) => void;
              };
              const minionWithListeners = minion as unknown as { _tempMCPListeners?: TempListeners };
              const listeners = minionWithListeners._tempMCPListeners;
              if (listeners && minion.executor) {
                minion.executor.off('content', listeners.content);
                minion.executor.off('turn_ended', listeners.turn_ended);
                minion.executor.off('error', listeners.error);
                delete minionWithListeners._tempMCPListeners;
              }
            }
          }
          case 'kill': {
            if (!this.minionManager) {
              throw new Error('Minion manager not initialized');
            }
            const { minionId } = args;
            const result = await killMinion(this.minionManager, minionId as string, this.wingsDir);
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          }
          default:
            throw new Error(`Unknown minions action: ${minionsAction}`);
        }
      }

      case 'missions': {
        const { action: missionsAction } = args;
        switch (missionsAction) {
          case 'list': {
            const wing = this.getValidatedWing(args);

            // Return cached result if available — missions only change on costume install.
            const cached = this.missionListCache.get(wing.name);
            if (cached) {
              return { content: [{ type: 'text', text: JSON.stringify({ missions: cached }) }] };
            }

            // Cache miss: discover and load all missions, then cache the result.
            const loader = new ClosetMissionLoader({ wing, loadModule: this.moduleLoader });
            const missionInfos = await loader.discover();

            let anyLoadFailed = false;
            const missions: MissionSummary_[] = await Promise.all(
              missionInfos.map(async (info): Promise<MissionSummary_> => {
                if (!info.runnable) {
                  return {
                    costume: info.costume,
                    name: info.name,
                    isLegacy: info.isLegacy,
                    runnable: false,
                    unrunnableReason: info.unrunnableReason,
                  };
                }
                try {
                  const loaded = await loader.load(info.costume, info.name);
                  return {
                    costume: info.costume,
                    name: info.name,
                    description: loaded.mission.description,
                    argsSchema: loaded.mission.args,
                    isLegacy: info.isLegacy,
                    runnable: true,
                  };
                } catch (loadErr) {
                  anyLoadFailed = true;
                  console.error(`[MCPServer] Failed to load mission ${info.costume}/${info.name}:`, loadErr);
                  return {
                    costume: info.costume,
                    name: info.name,
                    isLegacy: info.isLegacy,
                    runnable: true,
                  };
                }
              })
            );

            if (!anyLoadFailed) {
              this.missionListCache.set(wing.name, missions);
            }

            return { content: [{ type: 'text', text: JSON.stringify({ missions }) }] };
          }
          case 'start': {
            if (!this.missionService) {
              throw new Error('Mission service not initialized');
            }
            const { costume, mission: missionName, args: missionArgs } = args;
            const wing = this.getValidatedWing(args);

            const result = await this.missionService.start(
              wing,
              costume as string,
              missionName as string,
              (missionArgs as Record<string, unknown>) ?? {}
            );

            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  missionRunId: result.missionRunId,
                  missionName: result.missionName,
                  costume,
                })
              }]
            };
          }
          case 'events': {
            if (!this.missionService) {
              throw new Error('Mission service not initialized');
            }
            const { missionRunId } = args;
            const result = this.missionService.getEvents(missionRunId as string);
            if (!result) {
              throw new Error(`Mission not found: ${missionRunId}`);
            }
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  missionRunId,
                  status: result.status,
                  events: result.events,
                })
              }]
            };
          }
          case 'cancel': {
            if (!this.missionService) {
              throw new Error('Mission service not initialized');
            }
            const { missionRunId, reason } = args;
            const success = this.missionService.cancel(
              missionRunId as string,
              reason as string | undefined
            );
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({ success, missionRunId })
              }]
            };
          }
          case 'running': {
            if (!this.missionService) {
              throw new Error('Mission service not initialized');
            }
            const { wingName } = args;
            const tracked = this.missionService.list(wingName as string | undefined);
            const missions = tracked.map((m) => ({
              missionRunId: m.handle.id,
              missionName: m.handle.missionName,
              costume: m.costume,
              wingName: m.wingName,
              status: m.status,
              startedAt: m.events[0]?.timestamp ?? Date.now(),
            }));
            return { content: [{ type: 'text', text: JSON.stringify({ missions }) }] };
          }
          default:
            throw new Error(`Unknown missions action: ${missionsAction}`);
        }
      }

      case 'quality_status': {
        if (this.isQualityWatchingDisabled()) {
          return {
            content: [{
              type: 'text',
              text: 'The quality watcher tool is currently disabled (HACK_OFF_QUALITY_CHECKS). '
                + 'Run lint, typecheck, and unit tests yourself before checking in — do not '
                + 'assume the codebase passes just because this tool is unavailable.',
            }],
          };
        }
        const wing = this.getValidatedWing(args, extra.sessionId);
        const { treatWarningsAsWarnings } = args;
        const watcher = await this.getOrCreateQualityWatcher(wing.name, wing);
        if (!watcher) {
          throw new Error('Quality watcher unexpectedly unavailable (flags changed mid-request — retry).');
        }
        const status = await watcher.awaitStatus(undefined, treatWarningsAsWarnings === true);
        const emergencyNote = this.recentQualityWatcherEmergencyNote();

        return {
          content: [
            { type: 'text', text: (emergencyNote ? `${emergencyNote}\n\n` : '') + JSON.stringify(status, null, 2) }
          ]
        };
      }

      case 'review': {
        if (!this.missionService) {
          throw new Error('Mission service not initialized');
        }
        const { paths, purpose, scope, callerSessionId } = args;
        const wing = this.getValidatedWing(args, extra.sessionId);

        const result = await this.missionService.startAndWait(
          wing,
          undefined,
          'review-documents',
          { paths, purpose, scope, callerSessionId }
        );
        const { summary, changedFiles } = result;

        return { content: [{ type: 'text', text: JSON.stringify({ summary, changedFiles }) }] };
      }

      case 'gsd_compute_frames': {
        const { computeGsdFrames } = await import('../gsd/GsdFrameService.js');
        const { items, rootIds } = args;
        const claudeAuthToken = await this.readClaudeOAuthToken();
        const frames = await computeGsdFrames(
          items as Record<string, import('@minions/mcp-types').PlanItemRecordView>,
          rootIds as string[],
          claudeAuthToken,
        );
        return { content: [{ type: 'text', text: JSON.stringify({ frames }) }] };
      }

      default: {
        // Exhaustiveness check: this should never be reached
        const _exhaustive: never = toolName;
        throw new Error(`Unknown tool: ${_exhaustive}`);
      }
    }
  }

  /**
   * Infer broadcast interest category from a tool name
   */
  private inferInterestFromTool(toolName: string): string | null {
    switch (toolName) {
      case 'ask':
        return 'question';
      case 'missions':
        return 'mission';
      case 'minions':
        return 'minion';
      default:
        return null;
    }
  }

  /**
   * Infer broadcast category from event data
   */
  private inferCategoryFromData(data: unknown): string | null {
    if (data && typeof data === 'object' && 'type' in data) {
      const type = (data as { type: string }).type;
      if (type === 'mission_event') return 'mission';
      if (type.startsWith('question_')) return 'question';
      if (type.startsWith('minion_')) return 'minion';
    }
    return null;
  }

  /**
   * Register a tool with the MCP server
   * Type-safe: only allows registering tools with known names that have handlers
   */
  registerTool(tool: Tool & { name: ToolName }): void {
    // Runtime validation that tool name is known
    if (!isKnownTool(tool.name)) {
      throw new Error(
        `Cannot register unknown tool: ${tool.name}. ` +
        `Tool must be added to ToolName union type and have a handler in MCPServer.ts`
      );
    }

    const endpoints = (Object.keys(ENDPOINT_TOOL_SETS) as Exclude<EndpointName, 'all'>[])
      .filter((ep) => (ENDPOINT_TOOL_SETS[ep] as readonly string[]).includes(tool.name));
    this.core.registerTool(tool, endpoints);
  }

  /**
   * Register a file-based gadget with the MCP server.
   * Throws if the gadget name collides with a built-in tool or another gadget.
   */
  registerGadget(costumeName: string, gadget: Gadget): void {
    if (isKnownTool(gadget.name)) {
      throw new Error(
        `Gadget "${gadget.name}" from "${costumeName}" collides with built-in tool`
      );
    }

    if (this.core.hasActionGroup(gadget.name)) {
      throw new Error(
        `Gadget "${gadget.name}" from "${costumeName}" collides with action group`
      );
    }

    const existing = this.gadgetHandlers.get(gadget.name);
    if (existing) {
      throw new Error(
        `Gadget "${gadget.name}" from "${costumeName}" collides with gadget from "${existing.costumeName}"`
      );
    }

    this.core.registerTool(
      { name: gadget.name, description: gadget.description, inputSchema: gadget.args as Tool['inputSchema'] },
      ['henchery'],
    );

    this.gadgetHandlers.set(gadget.name, {
      costumeName,
      gadget,
    });
  }

  /**
   * Connect the server to its transport (no-op in per-session mode)
   * @deprecated Per-session mode creates connections on demand
   */
  async connect(): Promise<void> {
    // No-op - connections are created per-session in handleRequest
  }

  /**
   * Connect to all external MCP servers declared by the active costumes and collect their
   * tools (namespaced as `<serverName>__<toolName>`).
   *
   * Servers whose costume is no longer active are left connected until `disconnectAll` —
   * wing isolation is handled at the tools/list level (inactive servers are simply not
   * returned to the wing).
   */
  private async collectProxyTools(activeCostumes: Set<string> | undefined): Promise<Tool[]> {
    if (!this.sandbox || !activeCostumes) return [];
    try {
      const lairRoot = this.sandbox.root as Directory;
      const summaries = await readClosetCostumes(lairRoot);
      const externalServers = resolveExternalServers([...activeCostumes], summaries);

      // Ensure connections exist for all declared servers
      await Promise.all(
        Object.entries(externalServers).map(([serverName, config]) =>
          this.proxy.ensureConnected(serverName, config).catch((err) => {
            console.warn(`[McpProxy] Failed to connect to '${serverName}':`, err);
          })
        )
      );

      // Collect tool lists only from servers that are active for this wing
      const toolLists = await Promise.all(
        Object.keys(externalServers).map((serverName) =>
          this.proxy.listTools(serverName).catch(() => [] as Tool[])
        )
      );
      return toolLists.flat();
    } catch (err) {
      console.warn('[McpProxy] Failed to collect proxy tools:', err);
      return [];
    }
  }

  /**
   * Resolve the set of active costume names for a wing by reading its accessories.json.
   * Returns undefined if no accessories config is found (meaning all gadgets should be shown).
   */
  private async resolveActiveCostumes(wingName: string): Promise<Set<string> | undefined> {
    if (!this.sandbox) return undefined;
    try {
      const lairRoot = this.sandbox.root as Directory;
      const wingsResult = await lairRoot.child('wings');
      if (!wingsResult.found || wingsResult.node.kind !== 'directory') return undefined;
      const wingResult = await (wingsResult.node as Directory).child(wingName);
      if (!wingResult.found || wingResult.node.kind !== 'directory') return undefined;
      const wingRoot = wingResult.node as Directory;

      const config = await readAccessoriesFile(wingRoot);
      if (!config) return undefined;
      return new Set(config.costumes);
    } catch {
      // Ignore errors — fall back to showing all gadgets
    }
    return undefined;
  }

  /**
   * Validate and retrieve a wing, falling back to the session's wing when no wingName in args.
   */
  private getValidatedWing(args: Record<string, unknown>, sessionId?: string): ReturnType<WingManager['getWing']> & { root: { path: string } } {
    if (!this.wingManager) {
      throw new Error('Wing manager not initialized');
    }
    const wingName = this.core.getSessionMeta(sessionId)?.wingName ?? (args.wingName as string | undefined);
    if (!wingName) {
      throw new Error('Wing name not found: provide wingName in args or call from a wing session');
    }
    const wing = this.wingManager.getWing(wingName);
    if (!wing) {
      throw new Error(`Wing not found: ${wingName}`);
    }
    return wing;
  }

  /**
   * Enumerate every checked-out work repo in a wing, keyed by its work/<name>
   * name (e.g. "local", "global", or a named extra work dir). A wing may
   * have more than one independent repo under work/ — each needs its own
   * quality watcher scoped to its own root, not the wing root.
   */
  private async getWorkRepoPaths(wing: Wing): Promise<Record<string, string>> {
    const paths: Record<string, string> = {};

    // local/global resolve via the `WorkArea` surface —
    // `workAreaLocal()`/`workAreaGlobal()` throw instead of returning
    // `{ exists: false }` when unset, so each is wrapped in its own
    // try/catch to omit the key when the worktree isn't set up.
    try {
      const local = await wing.workAreaLocal();
      paths.local = (await local.activeMovement()).files.path;
    } catch {
      // No work/local worktree set up — omit.
    }

    try {
      const global = await wing.workAreaGlobal();
      paths.global = (await global.activeMovement()).files.path;
    } catch {
      // No work/global worktree set up — omit.
    }

    // Named work uses `namedWorkPath()` — a raw-path-only accessor that
    // covers every named-work backing kind, including the plain-`junction`
    // case (a same-repo subdir with no worktree of its own) that
    // `workAreaNamed()` can never build a `WorkArea` for (no
    // `BareRepository` to attach a `Trunk`/`Movement` to).
    for (const name of await wing.namedWorkNames()) {
      const path = await wing.namedWorkPath(name);
      if (path) paths[name] = path;
    }

    return paths;
  }

  /**
   * True while `HACK_OFF_QUALITY_CHECKS` is suppressing quality watching and
   * `HIGHER_PERF_QUALITY_WATCHER` hasn't replaced it yet — the one place
   * that combination is evaluated, shared by `getOrCreateQualityWatcher`,
   * `getQualityStreamPayload`, and the `quality_status` tool handler so the
   * three can never disagree about whether quality watching is on.
   */
  private isQualityWatchingDisabled(): boolean {
    return FF().HACK_OFF_QUALITY_CHECKS && !FF().HIGHER_PERF_QUALITY_WATCHER;
  }

  /**
   * A human-visible "quality checking is on fire" note prepended to
   * `quality_status`'s own output for a short window after a Tier 3
   * emergency respawn — long enough that whoever's next to call this tool
   * actually sees it, short enough that it doesn't read as a permanent
   * warning about an incident that's long since recovered.
   */
  private static readonly EMERGENCY_NOTE_WINDOW_MS = 5 * 60_000;

  /** How many of the crash's retained recent-output lines to quote in the note — a taste, not the whole capture (`getRecentOutput()`/`EmergencyRecord.recentOutput` already hold up to 50). */
  private static readonly EMERGENCY_NOTE_OUTPUT_LINES = 10;

  private recentQualityWatcherEmergencyNote(): string | undefined {
    const emergency = this.qualityWatcherProcessClient.getLastEmergency();
    if (!emergency) return undefined;
    const ageMs = Date.now() - emergency.at.getTime();
    if (ageMs > MCPServer.EMERGENCY_NOTE_WINDOW_MS) return undefined;
    const recentOutput = emergency.recentOutput.slice(-MCPServer.EMERGENCY_NOTE_OUTPUT_LINES);
    return (
      `🔥 QUALITY CHECKING WAS ON FIRE ${Math.round(ageMs / 1000)}s AGO (reason: ${emergency.reason}) — ` +
      'the quality-watcher-process failed and cabinet auto-respawned it. The status below is from the ' +
      'freshly-respawned process; if it still looks stale or wrong, investigate further rather than trusting it blindly.' +
      (recentOutput.length > 0 ? `\nWhat it was last doing before the failure:\n${recentOutput.join('\n')}` : '')
    );
  }

  /**
   * Get (starting or restarting as needed) the WingQualityWatcher for a wing.
   * Shared by the `quality_status` tool, the `movement` action group's
   * commit-check pipeline (`QualitySignalReader` detector), and wing-session
   * warm-up (see `wingSessions`) — all read/drive the same live signal cache
   * instead of each spawning their own watcher.
   *
   * `HIGHER_PERF_QUALITY_WATCHER` is checked first and, when on, always
   * produces a `RemoteQualityWatcher` regardless of `HACK_OFF_QUALITY_CHECKS`
   * — the hack flag exists to suppress the old in-process watcher in prod
   * while the replacement is validated in dev, not to suppress the
   * replacement itself. Otherwise, returns `undefined` while
   * `HACK_OFF_QUALITY_CHECKS` is on (see `libs/feature-flags/src/flags.ts`
   * for why): every caller already tolerates a missing watcher —
   * `QualitySignalReader` emits no evidence (never blocks the
   * movement-commit gate) and `warmQualityWatcher` just ignores the
   * resolved value — except `quality_status`, which checks the flag itself
   * first and never reaches this call.
   */
  private async getOrCreateQualityWatcher(wingName: string, wing?: Wing): Promise<IQualityWatcher | undefined> {
    const factory = this.qualityWatcherFactory;
    if (!factory) return undefined;

    if (FF().HIGHER_PERF_QUALITY_WATCHER) {
      let remoteWatcher = this.qualityWatchers.get(wingName);
      if (!remoteWatcher) {
        const resolvedWing = wing ?? this.wingManager?.getWing(wingName);
        if (!resolvedWing) throw new Error(`Wing not found: ${wingName}`);
        const [baseUrl, workRepoPaths] = await Promise.all([
          this.qualityWatcherProcessClient.ensureStarted(),
          this.getWorkRepoPaths(resolvedWing),
        ]);
        remoteWatcher = factory.createRemoteWatcher(wingName, baseUrl, workRepoPaths);
        this.qualityWatchers.set(wingName, remoteWatcher);
      }
      if (!remoteWatcher.isRunning()) {
        await remoteWatcher.start();
      }
      return remoteWatcher;
    }

    if (this.isQualityWatchingDisabled()) return undefined;
    let watcher = this.qualityWatchers.get(wingName);
    if (!watcher) {
      const resolvedWing = wing ?? this.wingManager?.getWing(wingName);
      if (!resolvedWing) throw new Error(`Wing not found: ${wingName}`);
      const workRepoPaths = await this.getWorkRepoPaths(resolvedWing);
      watcher = factory.createWingWatcher(wingName, workRepoPaths);
      this.qualityWatchers.set(wingName, watcher);
    }
    if (!watcher.isRunning()) {
      await watcher.start();
    }
    return watcher;
  }

  /** Warm up a wing's quality watcher as soon as a session connects, so results are ready by the time it's asked for. */
  private warmQualityWatcher(wingName: string): void {
    this.getOrCreateQualityWatcher(wingName).catch((err) => {
      console.error(`[MCPApi] Failed to warm quality watcher for wing ${wingName}:`, err);
    });
  }

  /**
   * Snapshot of every currently-watched wing's live quality status, for the
   * `/api/quality/stream` SSE endpoint (server.ts). Only reads the already-
   * cached `getStatus()` of watchers that exist — it never creates or warms
   * one, since a wing with no active session/watcher isn't "watched" and
   * has nothing live to report. Mirrors the `quality_status` tool's own
   * disabled-flag short-circuit (see that handler's comment) so the two
   * never disagree about whether quality watching is on.
   */
  getQualityStreamPayload(): QualityStreamPayload {
    const disabled = this.isQualityWatchingDisabled();
    const entries = disabled
      ? []
      : [...this.qualityWatchers.entries()].map(([wingName, watcher]) => ({ wingName, status: watcher.getStatus() }));
    const lastEmergency = this.qualityWatcherProcessClient.getLastEmergency();
    const emergency = lastEmergency ? { reason: lastEmergency.reason, at: lastEmergency.at.toISOString() } : undefined;
    return buildQualityStreamPayload(entries, disabled, emergency);
  }

  /** Stop a wing's quality watcher once it's been session-inactive past the grace period. */
  private coolQualityWatcher(wingName: string): void {
    this.qualityWatchers
      .get(wingName)
      ?.stop()
      .catch((err) => {
        console.error(`[MCPApi] Failed to stop quality watcher for wing ${wingName}:`, err);
      });
  }

  /**
   * Cabinet-driven pause/resume around `movement start`/`merge`/`promote`
   * (see docs/design/quality-watcher-process-redesign.md) — wired into the
   * movement action-group context as `ctx.pauseQualityWatcher`/
   * `resumeQualityWatcher`. Only meaningful for `RemoteQualityWatcher`: the
   * old in-process `WingQualityWatcher` already has its own autonomous
   * git-operation pause (`QualityWatcher.pollGitOperationState`), so a wing
   * without a live `RemoteQualityWatcher` (no session yet, or
   * `HIGHER_PERF_QUALITY_WATCHER` off) is correctly a no-op here.
   *
   * Best-effort by design: a watcher-process hiccup pausing/resuming must
   * never block or fail the real git operation it's wrapping, so failures
   * are caught and logged, never thrown.
   */
  private async pauseQualityWatcher(wingName: string): Promise<void> {
    const watcher = this.qualityWatchers.get(wingName);
    if (!watcher?.pause) return;
    try {
      await watcher.pause();
    } catch (err) {
      console.error(`[MCPApi] Failed to pause quality watcher for wing ${wingName}:`, err);
    }
  }

  /** See `pauseQualityWatcher`'s doc comment — the resume counterpart. */
  private async resumeQualityWatcher(wingName: string): Promise<void> {
    const watcher = this.qualityWatchers.get(wingName);
    if (!watcher?.resume) return;
    try {
      await watcher.resume();
    } catch (err) {
      console.error(`[MCPApi] Failed to resume quality watcher for wing ${wingName}:`, err);
    }
  }

  /**
   * Stop every currently-warm quality watcher — every watch-mode signal
   * runner's underlying subprocess (vue-tsc, Vitest, etc.) with it. Call
   * this before the process itself exits: without it, process exit leaves
   * every warm wing's subprocess tree behind as an orphan (see
   * ProcessWatchSignalRunner) — there is no OS-level "kill my children when
   * I die" on either platform this runs on, so this has to be explicit.
   *
   * Each wing's stop() is bounded to SHUTDOWN_TIMEOUT_MS rather than awaited
   * to completion: VitestSignalRunner.stop() awaits Vitest's own
   * `close()`, which under real load can take up to its configured
   * teardownTimeout (60s — see VitestSignalRunner for why that's set so
   * high) per wing, and this method historically awaited that in full,
   * making 'q'-to-quit look hung for up to a minute. That graceful wait
   * only matters while the process keeps running (a live restart needs its
   * old workers actually gone before starting new ones) — it buys nothing
   * here, because the process itself is about to exit. Vitest's `pool:
   * 'threads'` workers live inside this same process, so they're destroyed
   * for free the instant it exits, timed-out or not — no orphan risk.
   * Real OS child processes (vue-tsc et al, via ProcessWatchSignalRunner)
   * are a different story and DO need explicit killing, but that kill is
   * fired synchronously at the start of each runner's own stop() (see
   * killProcessTree), so it's already underway before this timeout can
   * even apply — abandoning the outer stop() promise doesn't abandon it.
   */
  async shutdown(): Promise<void> {
    const SHUTDOWN_TIMEOUT_MS = 5_000;
    // Fire every wing's stop() immediately, in parallel — each runner's real
    // kill (killProcessTree, handle.close(), ...) starts synchronously at
    // the top of its own stop(), so this is "tell them all to die at once".
    // Budget the WHOLE batch to one cumulative SHUTDOWN_TIMEOUT_MS rather
    // than SHUTDOWN_TIMEOUT_MS per watcher — with N warm wings, a per-watcher
    // race still only bounds each individual promise, and a caller relying
    // on this method to bound total time has no guarantee the underlying
    // await chain won't stall past it (see the hard watchdog in main.ts's
    // shutdown handler, which forcibly calls process.exit() if this whole
    // method doesn't return in time regardless of what happens here).
    const stopAll = Promise.all(
      [...this.qualityWatchers.entries()].map(([wingName, watcher]) =>
        watcher.stop().catch((err) => {
          console.error(`[MCPApi] Failed to stop quality watcher for wing ${wingName} during shutdown:`, err);
        })
      )
    );
    // A real OS process (unlike WingQualityWatcher's in-process workers)
    // that outlives this cabinet process unless explicitly killed.
    this.qualityWatcherProcessClient.stop();
    this.qualityWedgeBackstop.stop();
    await Promise.race([
      stopAll,
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)).then(() => {
        console.error(
          `[MCPApi] Quality watchers did not all stop within ${SHUTDOWN_TIMEOUT_MS}ms; proceeding with shutdown anyway (in-process workers die with this process; any real subprocess kills were already fired off).`
        );
      }),
    ]);
  }

  /** A human-readable label for logging: the session's client name, falling back to its id, falling back to 'stateless' when there's no session at all. */
  private describeSession(sessionId: string | undefined): string {
    if (!sessionId) return 'stateless';
    return this.core.getSessionMeta(sessionId)?.clientName ?? sessionId;
  }

  /** Called once a session finishes initializing — wires it into the wing-activity tracker (quality-watcher warm-up, idle detection). */
  private onSessionInitialized(sessionId: string, info: SessionInfo<SessionMeta>): void {
    console.log(`[MCPApi] Session ready: ${info.meta.clientName}`);
    this.wingSessions.sessionStarted(sessionId, {
      endpoint: info.endpoint as EndpointName,
      clientName: info.meta.clientName,
      wingName: info.meta.wingName,
      transport: info.transport,
      server: info.server,
    });
  }

  /** Called once a session's transport closes — the wing-activity tracker's idle debounce is the sole owner of what happens next. */
  private onSessionClosed(sessionId: string): void {
    console.log(`[MCPApi] Session closed: ${sessionId}`);
    this.wingSessions.sessionEnded(sessionId);
  }

  /**
   * Handle incoming HTTP request (POST, GET, or DELETE)
   * Creates per-session transports for proper MCP session management
   */
  async handleRequest(req: Request, res: Response, endpoint: EndpointName = ALL_ENDPOINTS, wingName?: string): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const method = req.body?.method;

    // Log meaningful requests, suppress noisy ones (GET/SSE, notifications/initialized)
    if (req.method === 'GET') {
      // SSE connections - suppress
    } else if (method === 'notifications/initialized') {
      // Suppress post-init notification
    } else if (method === 'tools/call') {
      const toolName = req.body?.params?.name;
      const sessionName = this.describeSession(sessionId);
      const action = this.core.hasActionGroup(toolName)
        ? ((req.body?.params?.arguments ?? {}) as Record<string, unknown>)['action']
        : undefined;
      const toolLabel = action ? `${toolName}:${action}` : toolName;
      const endpointLabel = wingName ? `${endpoint}/${wingName}` : endpoint;
      console.log(`[MCPApi] Tool ${toolLabel} (${sessionName}) via ${endpointLabel}`);
    } else if (!isInitializeRequest(req.body)) {
      console.log(`[MCPApi] ${req.method} ${method ?? 'unknown'}`);
    }

    if (isInitializeRequest(req.body)) {
      const clientName = req.body?.params?.clientInfo?.name ?? 'unknown';
      console.log(`[MCPApi] Session initializing: ${clientName}`);
    }

    await this.core.handleRequest(req, res, endpoint, {
      clientName: req.body?.params?.clientInfo?.name ?? 'unknown',
      wingName,
    });
  }

  /**
   * Broadcast a logging message to interested session clients
   * Used for pushing mission events, question updates, etc.
   */
  async broadcast(data: unknown): Promise<void> {
    const category = this.inferCategoryFromData(data);
    await this.core.broadcast(data, category);
  }

  /**
   * Get the number of connected sessions
   */
  getSessionCount(): number {
    return this.core.getSessionCount();
  }

  /**
   * Close all active sessions
   */
  async closeAll(): Promise<void> {
    await this.core.closeAll();
    await this.proxy.disconnectAll();
  }

  /**
   * Read the Claude Code CLI OAuth token from ~/.claude/.credentials.json via file-store.
   * Returns undefined when env-var auth is already configured or the file is absent.
   */
  private async readClaudeOAuthToken(): Promise<string | undefined> {
    if (process.env['ANTHROPIC_API_KEY'] || process.env['ANTHROPIC_AUTH_TOKEN']) return undefined;
    const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
    if (!home) return undefined;
    try {
      const homeSandbox = createDiskSandbox(home);
      const claudeResult = await homeSandbox.root.child('.claude');
      if (!claudeResult.found || !claudeResult.node.is('directory')) return undefined;
      const credsResult = await (claudeResult.node as Directory).child('.credentials.json');
      if (!credsResult.found || !credsResult.node.is('file')) return undefined;
      const content = await (credsResult.node as FileNode).read();
      const creds = JSON.parse(content) as Record<string, unknown>;
      const oauth = creds['claudeAiOauth'] as Record<string, string> | undefined;
      return oauth?.['accessToken'];
    } catch {
      return undefined;
    }
  }
}
