/**
 * Invalid extensions export for testing error handling — malformed action
 * group (missing coreActions, missing endpoints).
 */
export function getExtensions() {
  return {
    actionGroups: [{ def: { name: 'bad_group' } }],
  };
}
