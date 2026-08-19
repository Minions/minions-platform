#!/usr/bin/env node
// Scaffolds a new custom ESLint rule file (plus its allowlist stub, and the
// shared allowlist.mjs helper if this is the first rule in the repo) using
// the eolus-nabu-style layout: tools/custom-lint-rules/<rule-name>.mjs,
// tools/custom-lint-rules/allowlist.mjs, tools/custom-lint-rules/allowlists/
// <rule-name>.json. See .meta/workflows/add-lint-rule.md for the full
// workflow this is one step of.
//
// Usage: node scaffold-lint-rule.mjs <rule-name> [--type-aware]
// Run from anywhere inside the target repo — this walks up from the
// current directory to find it. Without --type-aware, the generated rule
// only sees syntax (no parserOptions.project, no TS program build — see
// docs/design/custom-lint-gate.md for why that's the default: 3.2s vs
// 11.9s measured live for the same rule/file-set with vs without it). Pass
// --type-aware when the rule genuinely needs inferred types, not just
// syntax (e.g. "flag a function whose inferred return type is a floating
// promise").

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const typeAware = args.includes('--type-aware');
const ruleName = args.find((a) => !a.startsWith('--'));
if (!ruleName || !/^[a-z][a-z0-9-]*$/.test(ruleName)) {
  console.error('Usage: node scaffold-lint-rule.mjs <rule-name> [--type-aware]  (kebab-case, e.g. no-forbidden-word)');
  process.exit(1);
}

// Repo root = the nearest ancestor directory (starting from cwd) containing
// eslint.custom-rules.config.mjs. Not assumed to be cwd — this script may be
// invoked from anywhere inside the repo.
function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 20; i += 1) {
    if (existsSync(join(dir, 'eslint.custom-rules.config.mjs'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const repoRoot = findRepoRoot(process.cwd());
if (!repoRoot) {
  console.error(
    'Could not find eslint.custom-rules.config.mjs in any ancestor of ' +
      process.cwd() +
      ' — run this from inside a repo that already has one (see add-lint-rule.md step 1).'
  );
  process.exit(1);
}

const rulesDir = join(repoRoot, 'tools', 'custom-lint-rules');
const allowlistsDir = join(rulesDir, 'allowlists');
const allowlistHelperPath = join(rulesDir, 'allowlist.mjs');
const ruleFilePath = join(rulesDir, `${ruleName}.mjs`);
const allowlistDataPath = join(allowlistsDir, `${ruleName}.json`);

mkdirSync(allowlistsDir, { recursive: true });

const ALLOWLIST_HELPER = `/**
 * Per-rule baselines of grandfathered violations. Each rule that uses one
 * calls \`loadAllowlist(ruleName, context)\` (INSIDE its own \`create(context)\`,
 * never at module scope) to read \`allowlists/<rule>.json\`
 * (\`{ description, files: [...] }\`) and suppress the listed files. The point
 * is to turn a rule on now without a giant up-front refactor: any NEW
 * violation (a file not in the list) fails, while existing ones are
 * tracked. Fix a file, then delete its line — burning the list down to
 * empty. Never add a new entry to one of these lists.
 *
 * Reads live via \`context.settings.qualityWatcher.loadDataFile\` when
 * available (mtime-memoized — an edit to the allowlist JSON is picked up
 * the next time this rule actually runs against an affected file, no
 * process restart needed) and falls back to a plain synchronous read
 * otherwise (e.g. running via a bare \`eslint\` CLI invocation, outside
 * quality-watcher).
 *
 * Each entry in \`files\` is either a bare repo-relative path, or
 * \`{ file, note }\` when the violation is worth its own justification —
 * \`note\` is documentation only, it plays no role in matching.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function readDataFile(path, context) {
  const loader = context?.settings?.qualityWatcher?.loadDataFile;
  if (loader) return loader(path);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** @returns {Set<string>} repo-relative paths exempt for the rule */
export function loadAllowlist(ruleName, context) {
  try {
    const parsed = readDataFile(join(here, 'allowlists', \`\${ruleName}.json\`), context);
    let files = parsed.files ?? [];
    if (Array.isArray(parsed)) files = parsed;
    const paths = files.map((entry) => (typeof entry === 'string' ? entry : entry.file));
    return new Set(paths.map((file) => file.replace(/\\\\/g, '/')));
  } catch {
    return new Set();
  }
}

/**
 * Absolute ESLint filename -> stable repo-relative key, matching what
 * allowlists/*.json entries are written as. Anchored on \`cwd\` (ESLint's own
 * \`context.cwd\` — the repo root it was constructed against), not a
 * hardcoded top-level-directory regex: works for any repo layout, not just
 * one with a fixed libs/apps/tools split.
 */
export function repoRelative(filename, cwd) {
  return relative(cwd, filename).replace(/\\\\/g, '/');
}

export function isAllowed(context, allowlist) {
  const filename = context.filename ?? context.getFilename();
  return allowlist.has(repoRelative(filename, context.cwd));
}
`;

const RULE_TEMPLATE_SYNTAX_ONLY = `import { loadAllowlist, isAllowed } from './allowlist.mjs';

// TODO: describe what this rule enforces and why, in one or two sentences.
const MESSAGE = 'TODO: violation message shown to the author.';

/**
 * TODO: one-paragraph description of what this rule bans/requires.
 * Existing offenders are listed in allowlists/${ruleName}.json — fix the
 * site to comply, then delete its entry.
 */
export const definition = {
  create(context) {
    const allowlist = loadAllowlist('${ruleName}', context);
    if (isAllowed(context, allowlist)) return {};

    // Reading a DIFFERENT kind of data file (not an allowlist)? Do the same
    // thing loadAllowlist does above: call
    // context.settings.qualityWatcher.loadDataFile(absolutePath) — inside
    // create(), never at module scope — so an edit to that file is picked
    // up the next time this rule actually runs, no restart needed.

    return {
      Program(node) {
        // TODO: rule logic. context.report({ node, message: MESSAGE });
      },
    };
  },
  meta: {
    docs: { description: 'TODO' },
    schema: [],
    type: 'problem',
  },
};

/** Push this into eslint.custom-rules.config.mjs's exported array. */
export const configEntry = {
  plugins: { local: { rules: { '${ruleName}': definition } } },
  rules: { 'local/${ruleName}': 'error' },
};
`;

const RULE_TEMPLATE_TYPE_AWARE = `import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';
import { loadAllowlist, isAllowed } from './allowlist.mjs';

// tools/custom-lint-rules/<rule>.mjs -> tools/custom-lint-rules -> tools -> repo root.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// TODO: describe what this rule enforces and why, in one or two sentences.
const MESSAGE = 'TODO: violation message shown to the author.';

/**
 * TODO: one-paragraph description of what this rule bans/requires.
 * Existing offenders are listed in allowlists/${ruleName}.json — fix the
 * site to comply, then delete its entry.
 */
export const definition = {
  create(context) {
    const allowlist = loadAllowlist('${ruleName}', context);
    if (isAllowed(context, allowlist)) return {};

    // Reading a DIFFERENT kind of data file (not an allowlist)? Do the same
    // thing loadAllowlist does above: call
    // context.settings.qualityWatcher.loadDataFile(absolutePath) — inside
    // create(), never at module scope — so an edit to that file is picked
    // up the next time this rule actually runs, no restart needed.

    const services = context.sourceCode.parserServices;
    if (!services || !services.program) return {};
    const checker = services.program.getTypeChecker();

    return {
      'ExpressionStatement > CallExpression'(node) {
        const tsNode = services.esTreeNodeToTSNodeMap.get(node);
        const type = checker.getTypeAtLocation(tsNode);
        // TODO: rule logic using \`type\`/\`checker\`. context.report({ node, message: MESSAGE });
      },
    };
  },
  meta: {
    docs: { description: 'TODO' },
    schema: [],
    type: 'problem',
  },
};

/**
 * Push this into eslint.custom-rules.config.mjs's exported array.
 * The \`files\` scoping below is required — without it, ESLint also tries to
 * type-aware-parse this very config file (and anything else your tsconfig
 * doesn't cover), and every one of those fails with a "TSConfig does not
 * include this file" parsing error instead of running this rule.
 */
export const configEntry = {
  files: ['**/*.ts'],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      project: join(repoRoot, 'tsconfig.json'),
      tsconfigRootDir: repoRoot,
    },
  },
  plugins: { local: { rules: { '${ruleName}': definition } } },
  rules: { 'local/${ruleName}': 'error' },
};
`;

const RULE_TEMPLATE = typeAware ? RULE_TEMPLATE_TYPE_AWARE : RULE_TEMPLATE_SYNTAX_ONLY;

const ALLOWLIST_DATA = JSON.stringify({ description: 'TODO', files: [] }, null, 2) + '\n';

if (!existsSync(allowlistHelperPath)) {
  writeFileSync(allowlistHelperPath, ALLOWLIST_HELPER);
  console.log('created', allowlistHelperPath);
} else {
  console.log('exists, left alone:', allowlistHelperPath);
}

if (existsSync(ruleFilePath)) {
  console.error(`refusing to overwrite existing rule file: ${ruleFilePath}`);
  process.exit(1);
}
writeFileSync(ruleFilePath, RULE_TEMPLATE);
console.log('created', ruleFilePath);

if (!existsSync(allowlistDataPath)) {
  writeFileSync(allowlistDataPath, ALLOWLIST_DATA);
  console.log('created', allowlistDataPath);
} else {
  console.log('exists, left alone:', allowlistDataPath);
}

console.log('\nNext: fill in', ruleFilePath, "'s rule logic, then register it in eslint.custom-rules.config.mjs — see add-lint-rule.md steps 4-7.");
