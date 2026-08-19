# Workflow: Add a Custom ESLint Rule

Concrete steps only. Full explanation/rationale: `docs/design/custom-lint-gate.md`.

## Layout this workflow produces

```
eslint.custom-rules.config.mjs
tools/custom-lint-rules/
  scaffold-lint-rule.mjs   # copied in once, see step 2
  allowlist.mjs            # shared helper, created automatically by the script
  <rule-name>.mjs          # one file per rule — exports `definition` AND `configEntry`
  allowlists/
    <rule-name>.json        # one file per rule that has an allowlist
```

## Steps

1. Locate `eslint.custom-rules.config.mjs` at the repo root. If it does not exist, create it with:
   ```js
   export default [];
   ```

2. Check: does `tools/custom-lint-rules/scaffold-lint-rule.mjs` already exist? If not, ask the human to copy it from the minions-nabu repo. End your turn and do not continue until the script is there for you.

3. Decide: does the rule need real type information (inferred types, not just syntax)?
   - No → run:
     ```
     node tools/custom-lint-rules/scaffold-lint-rule.mjs <rule-name>
     ```
   - Yes → run:
     ```
     node tools/custom-lint-rules/scaffold-lint-rule.mjs <rule-name> --type-aware
     ```
   `<rule-name>` is kebab-case, e.g. `no-forbidden-word`. Run this from anywhere inside the repo — it finds the repo root itself. It creates (or leaves alone if already present):
   - `tools/custom-lint-rules/allowlist.mjs` (shared helper, first rule only)
   - `tools/custom-lint-rules/<rule-name>.mjs` (the rule — refuses to overwrite if it already exists)
   - `tools/custom-lint-rules/allowlists/<rule-name>.json` (empty allowlist stub)

4. Open `tools/custom-lint-rules/<rule-name>.mjs`. It already contains a working example: it imports `loadAllowlist`/`isAllowed` from `./allowlist.mjs`, calls `loadAllowlist('<rule-name>', context)` inside `create(context)`, and returns `{}` early when `isAllowed(context, allowlist)` is true.

5. Replace the generated visitor body (`Program(node) { ... }` for the non-type-aware template, `'ExpressionStatement > CallExpression'(node) { ... }` for the type-aware one — add other visitor keys alongside/instead as needed) with the rule's real logic. Call `context.report({ node, message: '...' })` at each violation site.

6. Does the rule need to read a DIFFERENT data file (not the allowlist)? Inside `create(context)`, follow the same pattern the allowlist import already demonstrates:
   ```js
   const data = context.settings.qualityWatcher.loadDataFile('/absolute/path/to/file.json');
   ```
   Call this inside `create()`, never at module scope. Never cache the result yourself — `loadDataFile` already re-reads the file when its mtime changes.

7. Register the rule in `eslint.custom-rules.config.mjs`. Add this import at the top:
   ```js
   import { configEntry as myRuleEntry } from './tools/custom-lint-rules/<rule-name>.mjs';
   ```
   Add `myRuleEntry` to the exported array:
   ```js
   export default [
     myRuleEntry,
     // ...other entries
   ];
   ```

8. Verify: run
   ```
   pnpm exec eslint --config eslint.custom-rules.config.mjs <path-to-a-file-that-should-trigger-the-rule>
   ```
   Confirm the rule fires. Then run it against a file that should NOT trigger it and confirm it doesn't. If the rule has an allowlist, also add a triggering file's path to `tools/custom-lint-rules/allowlists/<rule-name>.json`'s `files` array and confirm it's suppressed.

9. Seed the allowlist with every current violation, so turning the rule on doesn't fail the build:
   ```
   pnpm exec eslint --config eslint.custom-rules.config.mjs .
   ```
   For every file reported, add its repo-relative path to the `files` array in `tools/custom-lint-rules/allowlists/<rule-name>.json`. Re-run the same command and confirm it now reports zero violations.
