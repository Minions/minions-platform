/**
 * Create Costume Gadget
 *
 * Creates a new empty costume with standard directory structure.
 */
import type { Gadget, GadgetContext, GadgetResult } from '@minions/gadgets';

const BUILD_JSON_TEMPLATE = `{
  "strategy": "copy"
}
`;

const COSTUME_JSON_TEMPLATE = `{
  "model": "claude-sonnet-4-20250514"
}
`;

const PROJECT_JSON_TEMPLATE = `{
  "name": "{{NAME}}",
  "$schema": "../../node_modules/nx/schemas/project-schema.json",
  "sourceRoot": "costumes/{{NAME}}/src",
  "projectType": "library",
  "targets": {
    "build": {
      "executor": "nx:run-commands",
      "cache": true,
      "options": {
        "command": "node ../../libs/costumes/src/build-costume.cjs",
        "cwd": "{projectRoot}"
      },
      "inputs": [
        "{projectRoot}/src/**/*",
        "{workspaceRoot}/libs/costumes/src/build-costume.cjs"
      ],
      "outputs": ["{projectRoot}/dist"]
    }
  }
}
`;

function applyTemplate(template: string, name: string): string {
  return template.replace(/\{\{NAME\}\}/g, name);
}

export const gadget: Gadget<{ wingName: string; costumeName: string }> = {
  name: 'create_costume',
  description: 'Create a new empty costume with standard directory structure (src/, build.json, project.json)',
  args: {
    type: 'object',
    properties: {
      wingName: {
        type: 'string',
        description: 'Name of the wing containing the monorepo',
      },
      costumeName: {
        type: 'string',
        description: 'Name for the new costume (lowercase, alphanumeric, hyphens)',
      },
    },
    required: ['wingName', 'costumeName'],
  },

  async execute(ctx: GadgetContext, args: { wingName: string; costumeName: string }): Promise<GadgetResult> {
    const { wingName, costumeName } = args;

    // Validate costume name (alphanumeric, hyphens, underscores)
    if (!/^[a-z][a-z0-9_-]*$/.test(costumeName)) {
      return {
        success: false,
        error: `Invalid costume name "${costumeName}". Use lowercase alphanumeric characters, hyphens, and underscores. Must start with a letter.`,
      };
    }

    const wing = ctx.getWing(wingName);
    if (!wing) {
      return { success: false, error: `Wing not found: ${wingName}` };
    }

    // Uses the design-doc-§4.2 `WorkArea` surface — `workAreaLocal()` throws
    // instead of returning `{ exists: false }`, caught here and mapped to the
    // same error result. Still writes without committing — deliberately out
    // of scope for this function to change.
    let worktree;
    try {
      const workArea = await wing.workAreaLocal();
      worktree = (await workArea.activeMovement()).files;
    } catch {
      return { success: false, error: `Wing ${wingName} has no work/local worktree` };
    }

    // Navigate to costumes directory
    const costumesResult = await worktree.child('costumes');
    if (!costumesResult.found || !costumesResult.node.isDirectoryLike()) {
      return { success: false, error: 'costumes/ directory not found in work/local' };
    }
    const costumesDir = costumesResult.node;

    // Check if costume already exists
    const existingResult = await costumesDir.child(costumeName);
    if (existingResult.found) {
      return { success: false, error: `Costume "${costumeName}" already exists` };
    }

    // Create costume directory structure
    const costumeDir = await costumesDir.createDirectory(costumeName);
    const srcDir = await costumeDir.createDirectory('src');

    // Write template files
    await srcDir.createFile('costume.json', applyTemplate(COSTUME_JSON_TEMPLATE, costumeName));
    await srcDir.createFile('build.json', applyTemplate(BUILD_JSON_TEMPLATE, costumeName));
    await costumeDir.createFile('project.json', applyTemplate(PROJECT_JSON_TEMPLATE, costumeName));

    return {
      success: true,
      result: {
        message: `Costume "${costumeName}" created at costumes/${costumeName}/`,
        files: [
          `costumes/${costumeName}/src/costume.json`,
          `costumes/${costumeName}/src/build.json`,
          `costumes/${costumeName}/project.json`,
        ],
      },
    };
  },
};
