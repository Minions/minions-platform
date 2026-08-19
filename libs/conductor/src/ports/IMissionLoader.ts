import type { Mission } from '../domain/Mission';

/**
 * Loaded mission information
 *
 * Contains the mission definition along with metadata about where it was loaded from.
 */
export interface LoadedMission {
  /** The mission definition (may be undefined if not runnable) */
  mission: Mission;

  /** Costume name this mission belongs to */
  costume: string;

  /** Path to the mission file */
  path: string;

  /** Whether this is a non-deterministic markdown mission (true) or a deterministic TypeScript/JS mission (false) */
  isLegacy: boolean;

  /** Whether the mission can be started (false for legacy Promise-based .ts missions) */
  runnable: boolean;

  /** If not runnable, explains why */
  unrunnableReason?: string;
}

/**
 * Mission discovery result
 *
 * Lightweight information about available missions without loading them.
 */
export interface MissionInfo {
  /** Mission name */
  name: string;

  /** Costume name */
  costume: string;

  /** Path to the mission file */
  path: string;

  /** Whether this is a non-deterministic markdown mission (true) or a deterministic TypeScript/JS mission (false) */
  isLegacy: boolean;

  /** Whether the mission can be started (false for legacy Promise-based .ts missions) */
  runnable: boolean;

  /** If not runnable, explains why */
  unrunnableReason?: string;
}

/**
 * Port for discovering and loading mission scripts
 *
 * IMissionLoader abstracts the details of finding and importing missions
 * from the closet. Different implementations can load from different sources:
 * - ClosetMissionLoader: Loads from installed costumes in the closet
 * - TestMissionLoader: Loads from in-memory mission definitions for testing
 *
 * The loader handles both deterministic TypeScript/JS mission scripts
 * and non-deterministic markdown missions (via wrapping).
 *
 * @example
 * ```typescript
 * const loader: IMissionLoader = new ClosetMissionLoader(closetPath);
 *
 * // Discover available missions
 * const missions = await loader.discover();
 * console.log(missions.map(m => `${m.costume}/${m.name}`));
 *
 * // Load a specific mission
 * const loaded = await loader.load('my-costume', 'refactor');
 * console.log(loaded.mission.description);
 * ```
 */
export interface IMissionLoader {
  /**
   * Discover all available missions
   *
   * Scans the closet for mission scripts and returns lightweight
   * information about each one without loading the full mission.
   *
   * @returns Array of mission information
   */
  discover(): Promise<MissionInfo[]>;

  /**
   * Discover missions for a specific costume
   *
   * @param costume - Costume name to filter by
   * @returns Array of mission information for that costume
   */
  discoverByCostume(costume: string): Promise<MissionInfo[]>;

  /**
   * Load a specific mission by costume and name
   *
   * Dynamically imports the mission module and validates it.
   * For non-deterministic markdown missions, wraps them in a script adapter.
   *
   * @param costume - Costume name
   * @param missionName - Mission name
   * @returns The loaded mission with metadata
   * @throws If the mission is not found or invalid
   */
  load(costume: string, missionName: string): Promise<LoadedMission>;

  /**
   * Find and load a mission by name across all costumes
   *
   * Searches all installed costumes for the first one that provides
   * the named mission and loads it. Useful when the caller doesn't
   * know (or shouldn't need to know) which costume owns the mission.
   *
   * @param missionName - Mission name to search for
   * @returns The loaded mission with metadata
   * @throws If no costume provides the mission
   */
  findAndLoad(missionName: string): Promise<LoadedMission>;

  /**
   * Check if a mission exists
   *
   * @param costume - Costume name
   * @param missionName - Mission name
   * @returns True if the mission exists
   */
  exists(costume: string, missionName: string): Promise<boolean>;
}
