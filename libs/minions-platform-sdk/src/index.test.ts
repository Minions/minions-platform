import { describe, it, expect } from 'vitest';
import * as sdk from './index.js';

describe('@minions/platform-sdk public surface', () => {
  it('re-exports the mcp-server-core mounting core', () => {
    expect(sdk.McpServerCore).toBeTypeOf('function');
    expect(sdk.ALL_ENDPOINTS).toBeDefined();
  });

  it('re-exports the minions-runtime-core standard tool set', () => {
    expect(sdk.MinionManager).toBeTypeOf('function');
    expect(sdk.MissionService).toBeTypeOf('function');
    expect(sdk.movementActionGroup).toBeDefined();
    expect(sdk.spawnMinion).toBeTypeOf('function');
  });

  it('re-exports the generic action-group primitives for authoring a custom ActionGroupDef', () => {
    expect(sdk.buildActionGroupSchema).toBeTypeOf('function');
    expect(sdk.buildActionGroupDescription).toBeTypeOf('function');
    expect(sdk.handleActionGroupHelp).toBeTypeOf('function');
    expect(sdk.dispatchActionGroup).toBeTypeOf('function');
  });
});
