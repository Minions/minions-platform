/**
 * The git branch a trunk's plan mirror lives on. Always `plan/<trunk>` —
 * `plan/main` for the default trunk is just this formula applied to `"main"`,
 * no special-casing needed here (only the on-disk path needs one, see above).
 */
export function planBranchName(trunk: string): string {
  return `plan/${trunk}`;
}

export function slugifyTrunk(trunk: string): string {
  return trunk.replace(/\//g, '-');
}
