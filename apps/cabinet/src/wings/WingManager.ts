import { join, dirname, basename } from 'node:path';
import {
  type Lair,
  type Wing,
  type Directory,
  type File,
  type BareRepository,
  type LairRepoName,
  type WorkArea,
  type WorkAreaFactories,
  generateWingClaudeMd,
  type ExtraWorkEntry,
  asLairRepoName,
  asRepoAlias,
  createDiskSandbox,
  createWorkArea,
  createWorkAreaFactoriesForSandbox,
} from '@minions/file-store';
import { TOOL_LOG_HOOK_SCRIPT, TOOL_LOG_HOOK_SCRIPT_NAME } from '@minions/movement-branching';

/**
 * WingManager that uses the file-store Lair API for all git operations.
 *
 * This replaces the previous path-based implementation that used direct
 * git CLI calls. All worktree, junction, and file operations are now
 * delegated to the file-store library.
 *
 * Accepts a Lair instance via constructor for dependency injection,
 * making it testable with in-memory sandboxes.
 */
export class WingManager {
  private wings = new Map<string, Wing>();
  private workAreaFactoriesCache: WorkAreaFactories | undefined;

  constructor(
    private readonly lair: Lair,
    private readonly cabinetPort: number
  ) {}

  /**
   * Lazily builds the `WorkAreaFactories` (design doc §4.2) needed to
   * construct `WorkArea` handles for wing creation / trunk-override
   * operations. Mirrors `libs/movement-branching`'s
   * `MovementActionGroup.ts`'s `resolveMovementScratchRoot`/
   * `resolveMovementWingContext` — same `{cabinet}/movement-scratch`
   * directory convention, so movement scratch worktrees created by either
   * call path live in one place. Built from `this.lair.sandbox` directly
   * rather than assuming the `Lair` this manager was constructed with
   * already carries `WorkAreaFactories` — keeps this self-contained
   * regardless of how the caller wired up its `Lair`. Production DOES pass
   * `workAreaFactories` to its own `createLair()` call today (see
   * `server.ts`), but `WingManager.test.ts` still constructs its `Lair` via
   * a bare `createLair(sandbox)` (no factories) — calling
   * `wing.workAreaLocalIfExists()` here directly would throw under that
   * still-common no-factories wiring, so this manager keeps building its own
   * regardless of what the `Lair` it was handed happens to carry.
   */
  private async getWorkAreaFactories(): Promise<WorkAreaFactories> {
    if (!this.workAreaFactoriesCache) {
      const cabinetDir = await this.lair.cabinet();
      const existing = await cabinetDir.child('movement-scratch');
      const scratchRoot =
        existing.found && existing.node.is('directory')
          ? (existing.node as Directory)
          : await cabinetDir.createDirectory('movement-scratch');
      this.workAreaFactoriesCache = createWorkAreaFactoriesForSandbox(this.lair.sandbox, scratchRoot);
    }
    return this.workAreaFactoriesCache;
  }

  /**
   * Builds a `WorkArea` (design doc §4.2) wrapping `wing`'s work/local
   * worktree, if it has one, so callers get `Trunk`/`Movement` semantics
   * instead of the raw `Worktree`. Returns `undefined` when the wing has no
   * work/local worktree set up (e.g. its `workLocalRepo` doesn't exist),
   * matching every existing caller's own `workLocalResult.exists` check.
   */
  private async getLocalWorkArea(wing: Wing): Promise<WorkArea | undefined> {
    const result = await wing.workLocal();
    if (!result.exists) return undefined;
    const factories = await this.getWorkAreaFactories();
    return createWorkArea(result.worktree.repository, result.worktree, factories);
  }

  /**
   * Constructs a `Trunk` (design doc §4.1) for `branch` in `workArea`'s
   * repo. `BareRepository` has no `trunk()` method of its own — Sandbox-
   * layer `Trunk` construction is deliberately adapter-specific (see
   * `libs/file-store/src/port/types.ts`'s doc comment on the Sandbox-layer
   * types), reached through the same `WorkAreaFactories.createTrunk` this
   * manager already builds for `WorkArea` construction.
   */
  private async getTrunk(workArea: WorkArea, branch: string) {
    const factories = await this.getWorkAreaFactories();
    return factories.createTrunk(workArea.repo, branch);
  }

  /**
   * Get the lair name (derived from lair root directory name)
   */
  get lairName(): string {
    return this.lair.name;
  }

  async scan(): Promise<void> {
    try {
      const fileStoreWings = await this.lair.wings();
      for (const wing of fileStoreWings) {
        this.wings.set(wing.name, wing);
      }
    } catch (e) {
      console.error('Failed to scan wings:', e);
    }
  }

  getWings(): Wing[] {
    return Array.from(this.wings.values());
  }

  getWing(name: string): Wing | undefined {
    return this.wings.get(name);
  }

  async getAvailableWorkRepos(): Promise<LairRepoName[]> {
    const repos = await this.lair.workRepos();
    // Return repo names without .git suffix for compatibility
    return repos.map((r: BareRepository) => asLairRepoName(r.name.replace(/\.git$/, '')));
  }

  async createWing(options: CreateWingOptions): Promise<Wing> {
    // Validate wing doesn't exist
    if (this.wings.has(options.name)) {
      throw new Error(`Wing "${options.name}" already exists`);
    }

    const privateLocalBranch = `l/${this.lairName}/w/${options.name}/local`;
    const privateGlobalBranch = `l/${this.lairName}/w/${options.name}/global`;

    try {
      // Use file-store Lair API to create the wing
      const wing = await this.lair.createWing(options.name, {
        workLocal: {
          repo: options.workLocalRepo,
          branch: options.workLocalBranch,
        },
        workGlobal: options.workGlobalRepo
          ? {
              repo: options.workGlobalRepo,
              // Dedicated per-wing branch, like privateGlobalBranch below —
              // never local `main` directly: a work/global worktree parked on
              // `main` permanently occupies that branch's one worktree slot,
              // which then blocks movement's `updateBranch('main', ...)`
              // force-updates (git refuses to force-move a branch checked out
              // in a worktree) for every other wing sharing that repo.
              branch: options.workGlobalBranch || `l/${this.lairName}/w/${options.name}/global`,
            }
          : undefined,
        extraWork: options.extraWork,
        privateLocal: { branch: privateLocalBranch },
        privateGlobal: { branch: privateGlobalBranch },
        infoLink: !options.customInfo,
        // Create default junction to lair closet - wings inherit lair costumes
        // Debug install will replace this with a directory when needed
        closetLink: true,
      });

      // Generate and write CLAUDE.md
      const claudeMdFile = await wing.claudeMd();
      const claudeMdContent = generateWingClaudeMd({
        wingName: options.name,
        lairName: this.lairName,
      });
      await claudeMdFile.write(claudeMdContent);

      // Propagate lair's .claude/settings.json to wing root so wing sessions
      // inherit enabledPlugins and other lair-level settings
      await this.propagateClaudeSettings(wing);

      // Install tool log hook so the wing records all tool usage
      await installToolLogHookTo(wing.root.path, wing.root, this.lair.root);

      // Default wing sessions to accepting edits without per-edit prompts
      await ensureDefaultPermissions(wing.root);

      // Write .mcp.json to configure the wing's client to use the cabinet MCP server
      await this.writeWingMcpSettings(wing);

      this.wings.set(options.name, wing);

      if (options.trunk) {
        // Persists the trunk override via `WorkArea.beginNewActiveMovement`'s
        // `base` option (design doc §4.2) rather than the raw
        // `Worktree.setBaseBranch` — the branch already exists (just created
        // above), so this re-targets its base without creating a new branch
        // or moving the checkout.
        const workArea = await this.getLocalWorkArea(wing);
        if (workArea) {
          await workArea.beginNewActiveMovement(options.workLocalBranch, {
            base: await this.getTrunk(workArea, options.trunk),
          });
        }
      }

      return wing;
    } catch (error) {
      // Rollback: Delete the partially created wing
      console.error('Wing creation failed, rolling back...', error);

      try {
        await this.lair.deleteWing(options.name);
      } catch (rollbackError) {
        console.error('Rollback failed:', rollbackError);
      }

      // Re-throw the original error
      throw error;
    }
  }

  /**
   * Update the work directory mappings for an existing wing.
   * Adds new named work dirs and/or removes existing ones without destroying the wing.
   */
  async updateWingWork(
    wingName: string,
    add?: Record<string, { repo: string; branch: string; subdir?: string }>,
    remove?: string[]
  ): Promise<void> {
    const wing = this.wings.get(wingName);
    if (!wing) {
      throw new Error(`Wing "${wingName}" not found`);
    }

    // Remove entries first
    for (const name of remove ?? []) {
      await wing.removeWorkNamed(asRepoAlias(name));
    }

    // Add new entries
    for (const [name, entry] of Object.entries(add ?? {})) {
      const repoResult = await this.lair.workRepo(entry.repo);
      if (!repoResult.exists) {
        throw new Error(`Work repo "${entry.repo}" not found`);
      }
      await wing.addWorkNamed(repoResult.repo, asRepoAlias(name), entry.branch, entry.subdir);
    }
  }

  /**
   * Install (or update) the tool log hook in one or all wings.
   * Safe to call on existing wings — idempotent.
   */
  async reprovisionHooks(wingName?: string): Promise<void> {
    const wings = wingName ? [this.wings.get(wingName)].filter(Boolean) as Wing[] : Array.from(this.wings.values());
    await Promise.all(wings.map((w) => installToolLogHookTo(w.root.path, w.root, this.lair.root)));
  }

  /**
   * Re-apply all provisioned wing files (CLAUDE.md, .mcp.json, .claude/settings.json,
   * tool log hook) for one wing or all wings. Safe to call on existing wings — idempotent.
   */
  async syncWing(wingName?: string): Promise<string[]> {
    const wings = wingName
      ? ([this.wings.get(wingName)].filter(Boolean) as Wing[])
      : Array.from(this.wings.values());

    if (wingName && wings.length === 0) {
      throw new Error(`Wing not found: ${wingName}`);
    }

    const synced: string[] = [];
    for (const wing of wings) {
      const claudeMdFile = await wing.claudeMd();
      await claudeMdFile.write(generateWingClaudeMd({ wingName: wing.name, lairName: this.lairName }));
      await this.propagateClaudeSettings(wing);
      await installToolLogHookTo(wing.root.path, wing.root, this.lair.root);
      await ensureDefaultPermissions(wing.root);
      await this.writeWingMcpSettings(wing);
      synced.push(wing.name);
    }
    return synced;
  }

  /**
   * Sets (or, with `null`, clears) an existing wing's `work/local` trunk
   * override. This is the primitive the `wings set-trunk` action and
   * experiment wing-assignment build on; it has no experiment-specific
   * knowledge of its own.
   *
   * Setting a trunk goes through the design-doc-§4.2 `Movement.base: Trunk`
   * surface (`WorkArea.beginNewActiveMovement`). **Clearing (`trunk: null`)
   * calls `workArea.clearActiveMovementBase()`** — the `WorkArea`/`Movement`
   * port surface itself has no "set an explicit empty base" operation
   * (`beginNewActiveMovement` always requires an explicit `base: Trunk`), so
   * clearing goes through this dedicated method instead, which clears BOTH
   * the repo-level mechanism AND the lower-level `--worktree`-scoped one
   * (`Worktree.setBaseBranch(null)`) — clearing only the repo-level key
   * would leave a stale value in the worktree-scoped mechanism, silently
   * resurrected on the next read (see `SiteWorkArea.clearActiveMovementBase`'s
   * own doc comment for why both must stay in sync).
   */
  async setWingTrunk(name: string, trunk: string | null): Promise<void> {
    const wing = this.wings.get(name);
    if (!wing) {
      throw new Error(`Wing "${name}" not found`);
    }
    if (trunk === null) {
      const clearWorkArea = await this.getLocalWorkArea(wing);
      if (!clearWorkArea) {
        throw new Error(`Wing "${name}" has no work/local worktree`);
      }
      await clearWorkArea.clearActiveMovementBase();
      return;
    }
    const workArea = await this.getLocalWorkArea(wing);
    if (!workArea) {
      throw new Error(`Wing "${name}" has no work/local worktree`);
    }
    const movement = await workArea.activeMovement();
    await workArea.beginNewActiveMovement(movement.branch, { base: await this.getTrunk(workArea, trunk) });
  }

  async deleteWing(name: string): Promise<void> {
    // Validate wing exists
    const wing = this.wings.get(name);
    if (!wing) {
      throw new Error(`Wing "${name}" not found`);
    }

    // Use file-store Lair API to delete the wing
    // This handles worktree removal and directory cleanup
    await this.lair.deleteWing(name);

    // Remove from manager
    this.wings.delete(name);
  }

  /**
   * Write .mcp.json at the wing root to configure the cabinet MCP server.
   */
  private async writeWingMcpSettings(wing: Wing): Promise<void> {
    const settings = {
      mcpServers: {
        cabinet: {
          type: 'http',
          url: `http://localhost:${this.cabinetPort}/mcp/henchery/${wing.name}`,
        },
      },
    };
    const content = JSON.stringify(settings, null, 2);

    const existingResult = await wing.root.child('.mcp.json');
    if (existingResult.found && existingResult.node.is('file')) {
      await (existingResult.node as File).write(content);
    } else {
      await wing.root.createFile('.mcp.json', content);
    }
  }

  /**
   * Propagate lair's .claude/settings.json enabledPlugins to the wing's
   * .claude/settings.json so that wing sessions inherit the lair's plugin configuration.
   *
   * Uses merge semantics: adds missing keys, never removes existing ones.
   */
  private async propagateClaudeSettings(wing: Wing): Promise<void> {
    const lairSettings = await this.readLairClaudeSettings();
    if (!lairSettings.enabledPlugins || Object.keys(lairSettings.enabledPlugins).length === 0) {
      return;
    }

    const claudeDir = await wing.root.createDirectory('.claude');
    const settingsPath = join(wing.root.path, '.claude', 'settings.json');
    await mergeEnabledPlugins(settingsPath, lairSettings.enabledPlugins, claudeDir);
  }

  /**
   * Read and parse the lair's .claude/settings.json.
   * Returns an empty object if it doesn't exist.
   */
  private async readLairClaudeSettings(): Promise<{ enabledPlugins?: Record<string, boolean>; [key: string]: unknown }> {
    const claudeResult = await this.lair.root.child('.claude');
    if (!claudeResult.found || !claudeResult.node.is('directory')) {
      return {};
    }
    const settingsResult = await (claudeResult.node as Directory).child('settings.json');
    if (!settingsResult.found || !settingsResult.node.is('file')) {
      return {};
    }
    try {
      const content = await (settingsResult.node as File).read();
      return JSON.parse(content) as { enabledPlugins?: Record<string, boolean>; [key: string]: unknown };
    } catch {
      return {};
    }
  }
}

export interface CreateWingOptions {
  name: string;
  workLocalRepo: string;
  workLocalBranch: string;
  workGlobalRepo?: string;
  workGlobalBranch?: string;
  customInfo?: boolean;
  /** Additional named work directories to create. Keys are dir names, must not be "local" or "global". */
  extraWork?: Record<string, ExtraWorkEntry>;
  /** Optional trunk override for work/local — see `WorkArea.beginNewActiveMovement`'s `base` option. Used to create a wing already targeting an experiment branch. */
  trunk?: string;
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Merge enabledPlugins entries into a Claude Code settings.json file.
 * Creates the file and parent directory if they don't exist.
 * Uses merge semantics: adds missing keys, never removes existing ones.
 */
export async function mergeEnabledPlugins(
  settingsPath: string,
  pluginsToAdd: Record<string, boolean>,
  dir: Directory = createDiskSandbox(dirname(settingsPath)).root
): Promise<void> {
  const fileName = basename(settingsPath);

  let settings: { enabledPlugins?: Record<string, boolean>; [key: string]: unknown } = {};
  const existingResult = await dir.child(fileName);
  if (existingResult.found && existingResult.node.is('file')) {
    try {
      const content = await (existingResult.node as File).read();
      settings = JSON.parse(content) as typeof settings;
    } catch {
      // File doesn't exist or isn't valid JSON — start fresh
    }
  }

  if (!settings.enabledPlugins) {
    settings.enabledPlugins = {};
  }

  let changed = false;
  for (const [key, value] of Object.entries(pluginsToAdd)) {
    if (!(key in settings.enabledPlugins)) {
      settings.enabledPlugins[key] = value;
      changed = true;
    }
  }

  if (changed) {
    await dir.createFile(fileName, JSON.stringify(settings, null, 2) + '\n');
  }
}

// ---------------------------------------------------------------------------
// Tool log hook installation
// ---------------------------------------------------------------------------

/**
 * Install (or update) the tool log hook for a wing.
 *
 * Writes log-tool-use.cjs to {lairRoot}/tools/ (shared across all wings in the
 * lair) and registers a PostToolUse hook in the wing's .claude/settings.json
 * using the absolute script path and the wing name as argument.
 *
 * The absolute path and explicit wing name mean the hook works regardless of
 * the agent's current working directory. Safe to call repeatedly — idempotent,
 * and updates any stale relative-path or old-format entries.
 */
export async function installToolLogHookTo(
  wingRootPath: string,
  wingDir: Directory = createDiskSandbox(wingRootPath).root,
  // Wing root is at {lairRoot}/wings/{wingName}, so two dirnames up = lairRoot
  lairDir: Directory = createDiskSandbox(dirname(dirname(wingRootPath))).root
): Promise<void> {
  const wingName = basename(wingRootPath);

  const toolsDir = await lairDir.createDirectory('tools');
  await toolsDir.createFile(TOOL_LOG_HOOK_SCRIPT_NAME, TOOL_LOG_HOOK_SCRIPT);
  const scriptPath = join(toolsDir.path, TOOL_LOG_HOOK_SCRIPT_NAME).replace(/\\/g, '/');

  const hookCommand = `node ${scriptPath} ${wingName}`;
  await mergeToolLogHook(wingDir, hookCommand);
}

/**
 * Ensure a wing's .claude/settings.json defaults sessions to accepting edits
 * without per-edit prompts. Merge semantics: only sets `permissions.defaultMode`
 * when absent, so a human's own customization is never overwritten.
 */
export async function ensureDefaultPermissions(wingDir: Directory): Promise<void> {
  const claudeDir = await wingDir.createDirectory('.claude');

  type Settings = { permissions?: { defaultMode?: string; [key: string]: unknown }; [key: string]: unknown };

  let settings: Settings = {};
  const settingsResult = await claudeDir.child('settings.json');
  if (settingsResult.found && settingsResult.node.is('file')) {
    try {
      settings = JSON.parse(await (settingsResult.node as File).read()) as Settings;
    } catch {
      // Invalid JSON — start fresh
    }
  }

  if (settings.permissions?.defaultMode !== undefined) {
    return;
  }

  settings.permissions = { ...settings.permissions, defaultMode: 'acceptEdits' };
  await claudeDir.createFile('settings.json', JSON.stringify(settings, null, 2) + '\n');
}

async function mergeToolLogHook(wingDir: Directory, hookCommand: string): Promise<void> {
  const claudeDir = await wingDir.createDirectory('.claude');

  type HookEntry = { matcher: string; hooks: Array<{ type: string; command: string }> };
  type Settings = { hooks?: { PostToolUse?: HookEntry[] }; [key: string]: unknown };

  let settings: Settings = {};
  const settingsResult = await claudeDir.child('settings.json');
  if (settingsResult.found && settingsResult.node.is('file')) {
    try {
      settings = JSON.parse(await (settingsResult.node as File).read()) as Settings;
    } catch {
      // Invalid JSON — start fresh
    }
  }

  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];

  // Detect any existing log-tool-use entry regardless of path or extension,
  // and replace it — a wing's settings.json may have been written with a
  // different relative-path .js/.mjs command variant, so matching loosely
  // on the `log-tool-use` substring is required to recognize it as the
  // same entry.
  for (const entry of settings.hooks.PostToolUse) {
    for (const h of entry.hooks ?? []) {
      if (h.command.includes('log-tool-use')) {
        if (h.command !== hookCommand) {
          h.command = hookCommand;
          await claudeDir.createFile('settings.json', JSON.stringify(settings, null, 2) + '\n');
        }
        return;
      }
    }
  }

  // No existing entry — add one
  settings.hooks.PostToolUse.push({
    matcher: '*',
    hooks: [{ type: 'command', command: hookCommand }],
  });
  await claudeDir.createFile('settings.json', JSON.stringify(settings, null, 2) + '\n');
}
