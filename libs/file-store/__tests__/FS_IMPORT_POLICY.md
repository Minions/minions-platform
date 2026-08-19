# Direct fs Import Policy

This document defines the policy for direct `fs` imports in the codebase: production code uses `@minions/file-store` instead of importing `fs`/`fs/promises` directly, with documented exceptions listed below.

## Policy

All production code MUST use `@minions/file-store` instead of direct `fs` or `fs/promises` imports, with documented exceptions listed below.

## Acceptable Exceptions

### 1. File-Store Adapters
**Location**: `libs/file-store/src/adapters/`

These files ARE the fs abstraction layer and must use fs directly.

### 2. File-Store Tests
**Location**: `libs/file-store/__tests__/`

Tests for the file-store adapters need direct fs access to set up test fixtures.

### 3. Build Scripts
**Location**: `apps/*/scripts/*.js`

Build and packaging scripts are dev tooling, not production code. Examples:
- `apps/cabinet/scripts/create-lair-package.js`
- `apps/cabinet/scripts/copy-throne-room.js`
- `apps/cabinet/scripts/build.js`

### 4. Dev Tooling Scripts
**Location**: `patterns/*/scripts/*.ts`

Developer productivity scripts for managing code patterns. Examples:
- `patterns/work-in-gaps/scripts/create-gap.ts`
- `patterns/work-in-gaps/scripts/refine-gap.ts`
- `patterns/work-in-gaps/scripts/create-bridge.ts`
- `patterns/work-in-gaps/scripts/record-insight.ts`

### 7. Coverage Reports
**Location**: `**/coverage/`

Generated files from test coverage tools.

### 8. Documentation
**Location**: `**/*.md`

Documentation files may reference fs imports in code examples.

## Verification

The policy is enforced by automated tests in `libs/file-store/__tests__/verify-no-fs-imports.test.ts`:

1. **General fs import check**: Scans the entire codebase for fs imports and verifies they match acceptable exceptions
2. **Costume mission check**: Specifically verifies no fs imports in costume production code

Run verification:
```bash
pnpm test libs/file-store/__tests__/verify-no-fs-imports.test.ts
```

## Updating This Policy

When adding new exceptions:
1. Document the exception in this file
2. Update the `isAcceptableException()` function in the verification test
3. Add a comment in the code explaining why the exception is necessary
