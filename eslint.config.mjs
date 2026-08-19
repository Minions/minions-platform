// Nx's `@nx/eslint:lint` executor only auto-detects flat config via this
// exact filename (see node_modules/@nx/eslint/src/utils/flat-config.js) —
// it never looks for eslint.custom-rules.config.mjs, so `nx run <proj>:lint`
// falls back to the legacy .eslintrc resolver and fails outright ("No
// ESLint configuration found") even though a real flat config exists. This
// file is that discovery hook; the actual rules live in
// eslint.custom-rules.config.mjs (kept as the canonical name so the direct
// invocation documented in CLAUDE.md — `eslint --config
// eslint.custom-rules.config.mjs` — keeps working unchanged).
export { default } from './eslint.custom-rules.config.mjs';
