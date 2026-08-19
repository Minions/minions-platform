/**
 * LairApi — Typed facade over cabinet services for in-process mission access
 *
 * Missions running in-process call these methods directly.
 * Minions in separate processes continue using HTTP MCP.
 * Both paths hit the same underlying implementations.
 */

import type { Directory, Wing } from '@minions/file-store';
import type { CostumeInstallResult, InstalledCostumeSummary } from '@minions/costumes';
import {
  installCostume as installCostumeImpl,
  debugInstallCostume as debugInstallCostumeImpl,
  listInstalledCostumes,
} from '@minions/costumes';

export type { CostumeInstallResult, InstalledCostumeSummary };

export interface LairApi {
  /**
   * Install a costume for production use (links to dist/).
   *
   * Creates closet/<installedName> junction and .claude/ links.
   * The costume must be built first.
   */
  installCostume(
    sourceWingName: string,
    costumePath: string,
    installedName: string
  ): Promise<CostumeInstallResult>;

  /**
   * Debug install a costume (links to src/).
   *
   * Creates wing closet junction and .claude/ links for live development.
   */
  debugInstallCostume(
    sourceWingName: string,
    costumePath: string,
    installedName: string,
    targetWing: Wing
  ): Promise<CostumeInstallResult>;

  /**
   * List all installed costumes in the lair closet.
   */
  listCostumes(): Promise<InstalledCostumeSummary[]>;
}

/**
 * Create a LairApi backed by the costume management functions from @minions/costumes.
 *
 * The lairRoot Directory is captured at creation time — all operations
 * use it without the caller needing to pass it.
 */
export function createLairApi(lairRoot: Directory): LairApi {
  return {
    installCostume: (sourceWingName, costumePath, installedName) =>
      installCostumeImpl(lairRoot, sourceWingName, costumePath, installedName),

    debugInstallCostume: (sourceWingName, costumePath, installedName, targetWing) =>
      debugInstallCostumeImpl(lairRoot, sourceWingName, costumePath, installedName, targetWing),

    listCostumes: () =>
      listInstalledCostumes(lairRoot),
  };
}
