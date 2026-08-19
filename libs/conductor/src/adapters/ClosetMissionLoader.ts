import { basename } from 'path';
import { pathToFileURL } from 'url';
import type { IMissionLoader, LoadedMission, MissionInfo } from '../ports/IMissionLoader';
import type { Mission } from '../domain/Mission';
import { isMission, isPromiseMission } from '../domain/Mission';
import { LegacyMissionWrapper } from './LegacyMissionWrapper';
import type { Wing, DirectoryLike, File, NodeKind } from '@minions/file-store';
import { getOverlaidCostumeDirectories } from '@minions/file-store';

/**
 * Check if a node kind represents a directory-like node (directory, junction, or worktree).
 * All three types support child() and children() operations.
 */
function isDirectoryLikeKind(kind: NodeKind): boolean {
  return kind === 'directory' || kind === 'junction' || kind === 'worktree';
}

/**
 * Options for creating a ClosetMissionLoader
 */
export interface ClosetMissionLoaderOptions {
  /**
   * Wing object for accessing the closet
   */
  wing: Wing;
  /**
   * Optional custom module loader for TypeScript mission files.
   * When provided (e.g. by the dev server's ViteNodeRunner), this is used instead of
   * native import() so that TypeScript source files and their @minions/* imports are
   * resolved through Vite's transform pipeline rather than native Node ESM.
   */
  loadModule?: (url: string) => Promise<Record<string, unknown>>;
}

/**
 * Loads mission scripts from the closet (installed costumes)
 *
 * The ClosetMissionLoader scans costume directories for TypeScript
 * mission files and loads them via dynamic import.
 *
 * The closet is accessed via the Wing.closet() method or Wing.root().child('closet').
 *
 * @example
 * ```typescript
 * // Create loader with Wing dependency
 * const loader = new ClosetMissionLoader({ wing });
 *
 * // Discover all missions
 * const missions = await loader.discover();
 *
 * // Load a specific mission
 * const loaded = await loader.load('my-costume', 'refactor');
 * ```
 */
export class ClosetMissionLoader implements IMissionLoader {
  private readonly wing: Wing;
  private readonly loadModule: (url: string) => Promise<Record<string, unknown>>;
  private readonly withSrcOverlay: boolean;
  private costumeMap: Map<string, DirectoryLike> | null = null;

  constructor(options: ClosetMissionLoaderOptions) {
    this.wing = options.wing;
    this.withSrcOverlay = !!options.loadModule;
    this.loadModule = options.loadModule ?? ((url) => import(url) as Promise<Record<string, unknown>>);
  }

  /**
   * Gets the overlaid costume map, initializing it on first access.
   * Lair costumes are the base, wing costumes override by name.
   */
  private async getCostumeMap(): Promise<Map<string, DirectoryLike>> {
    if (this.costumeMap) {
      return this.costumeMap;
    }

    this.costumeMap = await getOverlaidCostumeDirectories(this.wing, { includeSrcOverlay: this.withSrcOverlay });
    return this.costumeMap;
  }

  async discover(): Promise<MissionInfo[]> {
    try {
      const costumeMap = await this.getCostumeMap();

      const allMissions = await Promise.all(
        [...costumeMap.keys()].map((costumeName) => this.discoverByCostume(costumeName))
      );

      return allMissions.flat();
    } catch {
      // If there's an error reading costumes, return empty array
      return [];
    }
  }

  async discoverByCostume(costume: string): Promise<MissionInfo[]> {
    // Deterministic (.ts/.js) and non-deterministic (.md) missions with the
    // same name are distinct missions and both should be returned. Only .ts
    // and .js deduplicate against each other (source vs compiled form).
    const deterministicMap = new Map<string, MissionInfo>();
    const nonDeterministicMissions: MissionInfo[] = [];

    try {
      const costumeMap = await this.getCostumeMap();
      const costumeDir = costumeMap.get(costume);
      if (!costumeDir) {
        return [];
      }
      const missionsResult = await costumeDir.child('missions');
      if (!missionsResult.found || !isDirectoryLikeKind(missionsResult.node.kind)) {
        return [];
      }

      const missionsDir = missionsResult.node as DirectoryLike;
      const files = await missionsDir.children();

      for (const file of files) {
        if (file.kind !== 'file') {
          continue;
        }

        const fileName = file.name;

        // TypeScript source missions (.ts files, skip .test.ts and .d.ts)
        if (fileName.endsWith('.ts') && !fileName.endsWith('.test.ts') && !fileName.endsWith('.d.ts')) {
          const name = basename(fileName, '.ts');

          // .ts always wins over .js for deterministic missions
          deterministicMap.set(name, {
            name,
            costume,
            path: file.path,
            isLegacy: false,
            runnable: true, // Assumed runnable at discovery; validated at load time
          });
        }
        // Compiled JavaScript missions (.js files, skip .test.js)
        else if (fileName.endsWith('.js') && !fileName.endsWith('.test.js')) {
          const name = basename(fileName, '.js');

          // Only add if no .ts version already found
          if (!deterministicMap.has(name)) {
            deterministicMap.set(name, {
              name,
              costume,
              path: file.path,
              isLegacy: false,
              runnable: true, // Assumed runnable at discovery; validated at load time
            });
          }
        }
        // Non-deterministic markdown missions (.md files) - always included
        else if (fileName.endsWith('.md')) {
          const name = basename(fileName, '.md');

          nonDeterministicMissions.push({
            name,
            costume,
            path: file.path,
            isLegacy: true,
            runnable: true, // Markdown missions are wrapped by LegacyMissionWrapper
          });
        }
      }
    } catch {
      // If there's an error, return empty array
      return [];
    }

    // Validate all deterministic missions in parallel.
    // Files that don't export a valid mission (null result) are excluded entirely.
    const validationResults = await Promise.all(
      [...deterministicMap.values()].map((info) => this.validateMissionAtDiscovery(info))
    );
    const validatedDeterministic = validationResults.filter((v): v is MissionInfo => v !== null);

    return [...validatedDeterministic, ...nonDeterministicMissions];
  }

  /**
   * Validate a deterministic mission at discovery time by importing it
   * and checking for the 'api: effect' marker.
   *
   * Returns null if the file does not export a valid mission at all (e.g. it is
   * a helper utility accidentally placed in the missions directory). Such files
   * are silently excluded from discovery so they never appear in the mission list.
   *
   * Returns an unrunnable MissionInfo if the file exports a legacy Promise-based
   * mission, so developers can see that the mission needs to be updated.
   */
  private async validateMissionAtDiscovery(info: MissionInfo): Promise<MissionInfo | null> {
    try {
      const moduleUrl = pathToFileURL(info.path).href;
      const module = await this.loadModule(moduleUrl);
      const mission = module.mission as unknown;

      if (isMission(mission)) {
        return { ...info, runnable: true };
      }

      if (isPromiseMission(mission)) {
        const missionObj = mission as { name: string };
        return {
          ...info,
          runnable: false,
          unrunnableReason:
            `Mission "${missionObj.name}" uses the legacy Promise API and must be updated to use Effect.`,
        };
      }

      // File does not export a mission at all (e.g. a helper utility). Exclude it.
      return null;
    } catch {
      // If import fails, assume runnable (will fail at load time with a better error)
      return info;
    }
  }

  async load(costume: string, missionName: string): Promise<LoadedMission> {
    const costumeMap = await this.getCostumeMap();
    const costumeDir = costumeMap.get(costume);
    if (!costumeDir) {
      throw new Error(`Mission not found: ${costume}/${missionName}. Costume not found.`);
    }
    const missionsResult = await costumeDir.child('missions');
    if (!missionsResult.found || !isDirectoryLikeKind(missionsResult.node.kind)) {
      throw new Error(`Mission not found: ${costume}/${missionName}. Missions directory not found.`);
    }

    const missionsDir = missionsResult.node as DirectoryLike;

    // Try TypeScript source first
    const tsResult = await missionsDir.child(`${missionName}.ts`);
    if (tsResult.found && tsResult.node.kind === 'file') {
      return this.loadTypeScript(costume, missionName, tsResult.node.path);
    }

    // Try compiled JavaScript
    const jsResult = await missionsDir.child(`${missionName}.js`);
    if (jsResult.found && jsResult.node.kind === 'file') {
      return this.loadTypeScript(costume, missionName, jsResult.node.path);
    }

    // Try non-deterministic markdown
    const mdResult = await missionsDir.child(`${missionName}.md`);
    if (mdResult.found && mdResult.node.kind === 'file') {
      return this.loadNonDeterministic(costume, missionName, mdResult.node);
    }

    throw new Error(
      `Mission not found: ${costume}/${missionName}. ` +
      `Checked: ${missionName}.ts, ${missionName}.js, ${missionName}.md`
    );
  }

  private async loadTypeScript(
    costume: string,
    missionName: string,
    missionPath: string
  ): Promise<LoadedMission> {
    // Dynamic import the module
    // Use file:// URL with absolute path for cross-platform compatibility.
    // Do NOT append a cache-bust query parameter — vite-node's moduleCache
    // deduplicates concurrent requests for the same URL. Adding ?v=timestamp
    // makes each import unique, defeating that deduplication and overwhelming
    // the vite server when Promise.all loads many missions concurrently.
    const moduleUrl = pathToFileURL(missionPath).href;
    const module = await this.loadModule(moduleUrl);

    // Validate the export
    const mission = module.mission as unknown;
    if (isMission(mission)) {
      return {
        mission: mission as Mission,
        costume,
        path: missionPath,
        isLegacy: false,
        runnable: true,
      };
    }

    // Check if it's a legacy Promise-based mission
    if (isPromiseMission(mission)) {
      const missionObj = mission as { name: string; description: string };
      throw new Error(
        `Mission "${missionObj.name}" (${costume}/${missionName}) uses the legacy Promise API ` +
        `and must be updated to use Effect. Add 'api: "effect"' and change run() to return ` +
        `an Effect. See docs/design/mission-authoring.md for the Effect-based mission pattern.`
      );
    }

    throw new Error(
      `Invalid mission export: ${costume}/${missionName}. ` +
      `Expected 'export const mission: Mission<T>' with api: 'effect' but got ${typeof mission}`
    );
  }

  private async loadNonDeterministic(
    costume: string,
    _missionName: string,
    missionFile: File
  ): Promise<LoadedMission> {
    // Read the markdown file
    const markdown = await missionFile.read();
    const filename = basename(missionFile.path);

    // Wrap with LegacyMissionWrapper
    const mission = LegacyMissionWrapper.wrap(markdown, filename);

    return {
      mission,
      costume,
      path: missionFile.path,
      isLegacy: true,
      runnable: true, // Markdown missions are wrapped by LegacyMissionWrapper
    };
  }

  async findAndLoad(missionName: string): Promise<LoadedMission> {
    const costumeMap = await this.getCostumeMap();
    for (const costumeName of costumeMap.keys()) {
      if (await this.exists(costumeName, missionName)) {
        return this.load(costumeName, missionName);
      }
    }
    throw new Error(
      `Mission not found: no installed costume provides a mission named "${missionName}"`
    );
  }

  async exists(costume: string, missionName: string): Promise<boolean> {
    try {
      const costumeMap = await this.getCostumeMap();
      const costumeDir = costumeMap.get(costume);
      if (!costumeDir) {
        return false;
      }
      const missionsResult = await costumeDir.child('missions');
      if (!missionsResult.found || !isDirectoryLikeKind(missionsResult.node.kind)) {
        return false;
      }

      const missionsDir = missionsResult.node as DirectoryLike;

      // Check TypeScript source first
      const tsResult = await missionsDir.child(`${missionName}.ts`);
      if (tsResult.found && tsResult.node.kind === 'file') {
        return true;
      }

      // Check compiled JavaScript
      const jsResult = await missionsDir.child(`${missionName}.js`);
      if (jsResult.found && jsResult.node.kind === 'file') {
        return true;
      }

      // Check non-deterministic markdown
      const mdResult = await missionsDir.child(`${missionName}.md`);
      if (mdResult.found && mdResult.node.kind === 'file') {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }
}
