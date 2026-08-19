/**
 * Source of truth for the PostToolUse hook script installed in each lair.
 *
 * The script is CJS (.cjs) so Node.js treats it as CommonJS regardless of any
 * "type": "module" in parent package.json files. It receives the wing name as
 * process.argv[2] and resolves the lair root from its own __dirname, making the
 * log path independent of the agent's working directory.
 *
 * Exported so the hook test can reference it without going through the cabinet,
 * which would create a circular dependency.
 */

export const TOOL_LOG_HOOK_SCRIPT_NAME = 'log-tool-use.cjs';

export const TOOL_LOG_HOOK_SCRIPT = `#!/usr/bin/env node
'use strict';
const { readFileSync, appendFileSync, mkdirSync } = require('node:fs');
const { join, dirname } = require('node:path');

const wingName = process.argv[2];
if (!wingName) {
  process.stderr.write(
    '[log-tool-use] ERROR: wing name required as first argument.\\n' +
    '  Expected: node /path/to/log-tool-use.cjs <wing-name>\\n' +
    '  Fix the PostToolUse hook command in .claude/settings.json.\\n'
  );
  process.exit(1);
}

let data;
try {
  data = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const { tool_name: tool, tool_input: input } = data;
if (!tool) process.exit(0);

// Lair root: script lives at {lairRoot}/tools/, so dirname(__dirname) = lairRoot.
// LAIR_ROOT env var overrides for test isolation.
const lairRoot = process.env.LAIR_ROOT ?? dirname(__dirname);
const logDir = join(lairRoot, 'wings', wingName, 'private', 'untracked');
const logPath = join(logDir, 'tool-log.jsonl');

mkdirSync(logDir, { recursive: true });

const entry = { timestamp: Date.now(), tool };

if (tool === 'Edit' || tool === 'Write') {
  if (input?.file_path) entry.filePath = input.file_path;
} else if (tool === 'NotebookEdit') {
  if (input?.notebook_path) entry.filePath = input.notebook_path;
} else if (tool === 'Bash') {
  if (typeof input?.command === 'string') entry.command = input.command.slice(0, 500);
} else if (typeof tool === 'string' && tool.startsWith('mcp__')) {
  if (typeof input?.action === 'string') entry.mcpAction = input.action;
}

appendFileSync(logPath, JSON.stringify(entry) + '\\n');
`;
