// Custom-rules-only ESLint config — everything the standard lint check used
// to cover that oxlint (.oxlintrc.json) *cannot* do:
//
// - `@nx/enforce-module-boundaries`: workspace-graph-aware, no oxlint
//   equivalent exists.
// - `eslint-plugin-vue`'s `flat/essential` rules: oxlint's vue plugin only
//   ever sees a .vue file's extracted `<script>` block (see
//   https://oxc.rs/docs/guide/usage/linter/plugins.html) — it cannot lint
//   `<template>` content, which is most of what eslint-plugin-vue checks.
//
// Deliberately NOT type-aware (no `parserOptions.project`) — see
// runCustomLint.ts for why that matters for this signal's performance.
import nx from '@nx/eslint-plugin';
import pluginVue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
import tseslint from 'typescript-eslint';

const enforceModuleBoundaries = [
  'error',
  {
    enforceBuildableLibDependency: true,
    allow: ['^.*/eslint(\\.base|\\.custom-rules)?\\.config\\.[cm]?js$'],
    depConstraints: [
      // Platform boundary: browser code (Vue apps/libs) must never pull in
      // a Node-only implementation (fs/git/child_process) — that's how
      // libs/file-store's disk adapters ended up getting bundled (and
      // failing at runtime) for apps/throne-room. platform:universal is for
      // pure interfaces/types with no runtime environment dependency (e.g.
      // libs/planner-types, libs/mcp-types) — safe on both sides. One
      // direction only: this doesn't also forbid Node code from depending on
      // browser code — that's not a risk anyone's hit here, and enforcing it
      // would require tagging every Node-only lib in the workspace just to
      // keep them mutually legible to each other.
      {
        sourceTag: 'platform:browser',
        onlyDependOnLibsWithTags: ['platform:browser', 'platform:universal'],
      },
      {
        sourceTag: 'platform:universal',
        onlyDependOnLibsWithTags: ['platform:universal'],
      },
      {
        sourceTag: '*',
        onlyDependOnLibsWithTags: ['*'],
      },
    ],
  },
];

export default [
  // Global ignores — must be the only key on this object, or ESLint treats
  // it as a normal (non-global) config object instead.
  {
    ignores: ['.nx/**', '**/dist/**', '**/coverage/**', '**/test-output/**', 'apps/cabinet/src/throne-room/**'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    // Registers @typescript-eslint (so old `// eslint-disable-next-line
    // @typescript-eslint/...` comments still resolve to a known rule instead
    // of erroring) without enabling any of its rules — every
    // @typescript-eslint rule this workspace uses now lives in oxlint.
    // @nx is registered for enforce-module-boundaries below.
    plugins: { '@typescript-eslint': tseslint.plugin, '@nx': nx },
    languageOptions: {
      parser: tseslint.parser,
      sourceType: 'module',
    },
    rules: {
      '@nx/enforce-module-boundaries': enforceModuleBoundaries,
    },
  },
  // Vue template/component structure rules — not reachable by oxlint's vue
  // plugin, which only lints the extracted <script> block.
  ...pluginVue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    plugins: { '@nx': nx },
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        sourceType: 'module',
      },
    },
    rules: {
      '@nx/enforce-module-boundaries': enforceModuleBoundaries,
      // Disable strict formatting rules that don't affect correctness —
      // same intent as the standard-lint config this replaced.
      'vue/html-self-closing': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/attributes-order': 'off',
    },
  },
];
