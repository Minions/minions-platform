/**
 * Wing CLAUDE.md Template
 *
 * This template is used to generate the CLAUDE.md file for each wing.
 * It's embedded as a constant to avoid file system reads at runtime.
 */

/**
 * Options for generating a wing CLAUDE.md file.
 */
export interface WingClaudeMdOptions {
  wingName: string;
  lairName: string;
}

/**
 * The embedded template for wing CLAUDE.md files.
 * Uses simple string interpolation for generation.
 */
const WING_CLAUDE_MD_TEMPLATE = `# CLAUDE.md

This file describes how to work with the repositories in this wing.

## Universal Rules

* Be concise. Always talk to the human in the fewest words you can while still being clear and precise.
* Tell me something that I need to know even if I don't want to hear it.
* If you see an error, then notify me with a message that starts with a bomb emoji.

## When You Don't Know

When you don't know something, ask me as follows:

1. Consider several ideas.
2. Pick the best one. Propose it, starting with a gold star emoji, and state briefly and clearly why this works.
3. State the ones that you considered and rejected, each starting with a red X emoji, and state why you rejected each option.

* If there are multiple good ideas, then propose all of them and a spike that we could do to explore each of them and find out the best for this situation.

## Directory Structure

* Primary work product repository root is \`[wing-root]/work/local\`.
* Secondary work products repositories may exist in \`[wing-root]/work/[specific-name]\`. They will always be addressed by name.
* Private scratchpad repository root is \`[wing-root]/private/local\`.
* Read the \`[wing-root]/work/local/CLAUDE.md\` file for more details on working with this repository.

**Path resolution is automatic — but for Read/Write/Edit it works via a blocked-and-retried call, not a silent rewrite.** A \`PreToolUse\` hook sets the Bash tool's starting directory for you, and corrects Read/Write/Edit/Glob calls that use the wrong root. You do not need to manually prepend \`work/local/\`, but if you pass a relative path meant to be work-root-relative, the tool call will be denied once with a message giving you the corrected absolute path — retry immediately with that path. The rule the hook applies: a path starting with \`work/\`, \`private/\`, \`info/\`, \`closet/\`, \`.claude/\`, \`.mcp.json\`, \`.playwright/\` resolves against wing root; everything else resolves against the current work root (this deliberately excludes \`CLAUDE.md\` — \`work/local\` has its own, and a bare relative \`CLAUDE.md\` means that one). A file that genuinely exists at the wing-root location is always left alone, regardless of this rule.

Two environment variables are available in every Bash command: \`$WING_ROOT\` (fixed for the session) and \`$WORK_ROOT\` (the current work repo root — usually \`work/local\`, changes only if you intentionally switch to a different named work repo). Use \`$WING_ROOT/work/<name>/...\` to reach a different work repo explicitly, rather than relative \`../\` chains.

**Known gaps:**
- The hook sets the Bash tool's *starting* directory and corrects Read/Write/Edit/Glob-pattern params, but it does not rewrite paths embedded inside Bash command text beyond that starting point (e.g. a second \`cd\` later in a \`&&\`-chained command, or a path inside a git argument after cwd has already moved). Those still need manual care — prefer \`$WING_ROOT\`/\`$WORK_ROOT\`-relative paths in multi-step Bash commands rather than relative \`../\` navigation.
- \`Glob\`'s \`path\` parameter and \`Grep\`'s \`path\` parameter **cannot be corrected at all** — when a relative \`path\` doesn't resolve to a real directory under wing root, those tools fail before any hook gets a chance to intervene. Prefer folding the target directory into \`Glob\`'s \`pattern\` (e.g. \`"sharing-keystones/**/*.md"\` rather than \`pattern: "*.md", path: "sharing-keystones"\`), and avoid passing \`path\` to \`Grep\`.

## Wing Isolation

**CRITICAL: Only change files within this wing's directory.**

Each wing is a separate git worktree for the same repository, with a different agent running in it. Modifying files outside your wing will corrupt another agent's work.

- Never read or write files in another wing's directory (e.g. \`[lair-root]/wings/[other-wing]/\`)
- Wings named \`minions\` and \`planning\` are **production instances**, not source — do not edit their files directly
- If you spot something in a prod wing that needs fixing, make the change in source (within this wing's codebase) and let it deploy normally

## Git Workflow

This wing uses movement-based branching:

**Movement Branch**: \`{{MOVEMENT_BRANCH}}\`, or \`wip/[plan-id]\`.

A "movement" is a merge to main that represents one small, clear shift in the product. Each shift is accomplished via a set of small, logical steps.

### Working in Steps

Each logical step should be:
1. Developed on the movement branch
2. Verified to pass build, test, type check, and lint — check the \`quality_status\` MCP tool for live results instead of running these yourself; it keeps them continuously warm in the background
3. Committed using the movement commit MCP tool

You MUST work in small, logical steps. Usually each Todo item is one step and should be committed separately. There are often multiple commits per plan task. You MUST verify each commit passes all checks. You MUST resolve all issues before committing.

### Commit Requirements

You MUST commit when:

- You have completed a set of work and are ready for the next user prompt (when your turn is over)
- You have completed a Todo item and the code is in a passing state
- You are about to do work that is not tightly related to the work you just finished (in which case you must get the code to a passing state before committing)
- You are about to start refactoring or remodeling.
- You were asked to debug or fix a problem, and you have fixed part of it - even if there are still problems.
- Your turn started with code in a broken state and you have fixed one problem - even if it is not all the way fixed.

If you are unsure, then err on the side of committing. It is ALWAYS better to have more, smaller commits.

### Commit Size Guidelines

**One commit = one logical change**

Good commit sizes:
- One rename across all affected files
- One method extraction
- Add one feature with its tests
- Fix one bug with regression test
- Implement one Todo from the Todos tool

Bad commit sizes:
- Multiple unrelated renames
- Feature without tests (split into test + feature)
- Bug fix + unrelated refactoring

### Merging Movements

When the movement is complete, you must:
1. Verify that the movement didn't break any user-visible functionality
2. Merge the movement using the movement merge MCP tool

### MCP Tools for Git

**DO NOT use raw git commands for commit or merge.** Use the \`movement\` MCP tool instead.
Use \`movement action=help\` (or \`movement action=help command=<action>\`) for detailed help on any action.

#### Normal Workflow

Not all requests involve a plan item. Steps 3 and 6 apply only when the prompt or context references a plan item, usually by ID.

**CRITICAL: You MUST run \`movement action=start\` before doing any exploration or attempting to understand the user's prompt.** The user may be referencing plan items, files, or features that exist on main but are not yet on your branch.

1. \`movement action=start\` — sync branch to origin/main before making changes
2. **Immediately check \`quality_status\`** — before any other exploration. This is not optional and not just "look for issues if you happen to notice any": call it as your very next action after \`movement action=start\`.
   - If a signal is still \`pending\`/\`running\`, wait briefly and check again rather than treating that as clean — a freshly-warmed wing's watchers can still be cold-starting.
   - If anything reports \`fail\` (which now includes warnings — see \`quality_status\`'s \`treatWarningsAsWarnings\` parameter), stop and fix it first: work through each item in as many commits as it takes, in its own movement. Fixing means actually resolving it, or — if it's a deliberate exception — suppressing that *specific instance* with a comment recording the decision (never a blanket "ignore this warning everywhere" toggle).
   - Once \`quality_status\` is clean, \`movement action=merge\` the cleanup, then **stop** and ask the human to clear the context and re-issue their original request. Do not continue on to the original task in this same session — a cleanup movement and the requested work are different concerns and shouldn't share a diff or a context.
3. _(plan item only)_ Use \`plan action=list-roots wingName={{WING_NAME}}\` to find it, then \`plan action=get-subtree wingName={{WING_NAME}} itemId=...\` to read its full details and sub-items.
4. Make changes for one logical step
5. Check \`quality_status\` for build/test/typecheck/lint results — fix any issues it reports. Don't run these checks yourself; \`quality_status\` reflects a continuously-running watcher, so it's already up to date.
6. _(plan item only)_ If you have completed any plan items (main or sub-item), call \`plan action=delete-subtree wingName={{WING_NAME}} itemId=...\` for each one.
7. \`movement action=commit\` — commit the step (do not run \`git add\` first; it commits everything)
8. Repeat 3–7 for each step
9. \`movement action=merge\` — merge completed movement to main unless the human said to keep it open

#### Key Notes

- **start**: Always call at the start of a session — BEFORE any exploration or reading of the codebase. The user may reference things on main that your branch doesn't have yet. If the branch has uncommitted changes and is behind, commit them first.
- **commit**: The \`isComprehensive\` flag is true only if tests cover all adjacent invariants, not just the change itself.
- **merge**: Analyze all commits on the branch — some may predate the current conversation. Choose the highest-risk intention type (e.g., "feature" over "refactor").
- **status**: Useful for diagnosing problems, but not required in the normal flow.
- **plan list-roots**: Lists all top-level plan items by ID and title.
- **plan get-subtree**: Finds any plan item by ID (root or mid-tree) and returns its subtree of descendants plus markdown details and parent context.
- **plan delete-subtree**: ⚠️ Dangerous — marks an item done by permanently deleting it and its entire subtree. This is the only way to mark a plan item complete.
- **plan add-children**: Breaks an item into sub-items.

## Scripting Language

**Use JavaScript/TypeScript for all scripts, not Python.** Node.js (or Bun) is always available; Python may be absent. When writing one-off scripts, build tooling, or automation, reach for \`.js\`/\`.ts\` files run with \`node\` or \`bun\`.

## Architecture Principles

### Domain-Focused Design with Hexagonal Architecture

When building applications, follow domain-focused design implemented with hexagonal architecture:

**Each Domain Owns Its Infrastructure**

Each domain (hexagon) owns the infrastructure it needs. This means:
- Domain logic and its required infrastructure live together
- A domain contains only the specific infrastructure pieces it actually uses
- No shared infrastructure layer that all domains depend on by default

**Infrastructure Ownership Examples**

| Domain | Owns Its Own |
|--------|--------------|
| User domain | User repository, user cache |
| Order domain | Order repository, order events |
| Notification domain | Email sender, SMS gateway |

**Technical Domains**

When you notice repeated infrastructure patterns across domains, they MAY bud off as technical domains - but this is NOT assumed upfront:
- Start with infrastructure owned by each domain
- Only extract to a technical domain when duplication becomes clear
- Technical domains are discovered, not planned

### Walking Skeleton Approach

Build applications using a walking skeleton approach:
1. Define the simplest version of each domain up front
2. Create a minimal but complete vertical slice through the system
3. Incrementally flesh out each domain as stories require

This means the first slice should establish the core domain boundaries, even if implementations are trivial (returning hardcoded values, in-memory storage, etc.).
`;

/**
 * Generates a wing CLAUDE.md file content.
 *
 * @param options - Options for generating the content
 * @returns The generated CLAUDE.md content
 */
export function generateWingClaudeMd(options: WingClaudeMdOptions): string {
  const movementBranch = `l/${options.lairName}/w/${options.wingName}`;

  let content = WING_CLAUDE_MD_TEMPLATE;

  // Replace movement branch
  content = content.replace("{{MOVEMENT_BRANCH}}", movementBranch);

  // Replace wing name (used in plan tool call examples)
  content = content.split("{{WING_NAME}}").join(options.wingName);

  return content;
}
