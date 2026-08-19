/**
 * Costume Service for Cabinet
 *
 * Re-exports costume management operations from @minions/costumes.
 * Cabinet's MCP handlers import from here for backward compatibility.
 */

export type { CostumeInstallResult, InstalledCostumeSummary, MarketplaceCostumeInstallResult } from '@minions/costumes';
export { installCostume, debugInstallCostume, listInstalledCostumes, installMarketplaceCostume } from '@minions/costumes';
