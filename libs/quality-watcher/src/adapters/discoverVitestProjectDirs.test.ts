import { describe, it, expect } from 'vitest';
import { createInMemorySandbox, type Directory } from '@minions/file-store';
import { discoverVitestProjectDirs } from './discoverVitestProjectDirs.js';

const DEFAULT_TEST_CONFIG = 'export default { test: { include: ["src/**/*.test.ts"] } };';

async function makePath(root: Directory, path: string): Promise<Directory> {
  let dir = root;
  for (const segment of path.split('/').filter(Boolean)) {
    dir = await dir.createDirectory(segment);
  }
  return dir;
}

describe('discoverVitestProjectDirs', () => {
  it('finds a project directory with a vitest.config.ts', async () => {
    const root = createInMemorySandbox().root;
    const foo = await makePath(root, 'libs/foo');
    await foo.createFile('vitest.config.ts', DEFAULT_TEST_CONFIG);
    await foo.createDirectory('src');

    expect(await discoverVitestProjectDirs('/root', root)).toEqual([foo.path]);
  });

  it('finds a project directory with only a vite.config.ts', async () => {
    const root = createInMemorySandbox().root;
    const bar = await makePath(root, 'apps/bar');
    await bar.createFile('vite.config.ts', DEFAULT_TEST_CONFIG);

    expect(await discoverVitestProjectDirs('/root', root)).toEqual([bar.path]);
  });

  it('finds multiple independent project directories', async () => {
    const root = createInMemorySandbox().root;
    const a = await makePath(root, 'libs/a');
    await a.createFile('vitest.config.ts', DEFAULT_TEST_CONFIG);
    const b = await makePath(root, 'libs/b');
    await b.createFile('vite.config.ts', DEFAULT_TEST_CONFIG);
    const c = await makePath(root, 'apps/c');
    await c.createFile('vitest.config.ts', DEFAULT_TEST_CONFIG);

    const result = await discoverVitestProjectDirs('/root', root);
    expect(result.sort()).toEqual([a.path, b.path, c.path].sort());
  });

  it('does not descend into node_modules, .git, .nx, dist, or coverage', async () => {
    const root = createInMemorySandbox().root;
    const somePkg = await makePath(root, 'node_modules/some-pkg');
    await somePkg.createFile('vitest.config.ts', DEFAULT_TEST_CONFIG);
    const gitDir = await root.createDirectory('.git');
    await gitDir.createFile('vitest.config.ts', DEFAULT_TEST_CONFIG);
    const nxDir = await root.createDirectory('.nx');
    await nxDir.createFile('vitest.config.ts', DEFAULT_TEST_CONFIG);
    const distDir = await root.createDirectory('dist');
    await distDir.createFile('vitest.config.ts', DEFAULT_TEST_CONFIG);
    const coverageDir = await root.createDirectory('coverage');
    await coverageDir.createFile('vitest.config.ts', DEFAULT_TEST_CONFIG);
    await root.createDirectory('libs');

    expect(await discoverVitestProjectDirs('/root', root)).toEqual([]);
  });

  it('does not include a directory that has neither config file', async () => {
    const root = createInMemorySandbox().root;
    const foo = await makePath(root, 'libs/foo');
    await foo.createFile('package.json', '{}');
    await foo.createDirectory('src');

    expect(await discoverVitestProjectDirs('/root', root)).toEqual([]);
  });

  it('includes the root directory itself when it has a config file', async () => {
    const root = createInMemorySandbox().root;
    await root.createFile('vitest.config.ts', DEFAULT_TEST_CONFIG);
    await root.createDirectory('libs');

    expect(await discoverVitestProjectDirs('/root', root)).toEqual([root.path]);
  });

  it('returns an empty array for an unreadable (empty) directory', async () => {
    const root = createInMemorySandbox().root;

    expect(await discoverVitestProjectDirs('/root', root)).toEqual([]);
  });

  it('excludes a vite.config.ts with no test block — a build-only config, not a Vitest project', async () => {
    const root = createInMemorySandbox().root;
    const frontend = await makePath(root, 'apps/frontend');
    await frontend.createFile(
      'vite.config.ts',
      "import vue from '@vitejs/plugin-vue';\nexport default { plugins: [vue()], build: { outDir: 'dist' } };"
    );

    expect(await discoverVitestProjectDirs('/root', root)).toEqual([]);
  });

  it('includes a vite.config.ts that declares a test block alongside build config', async () => {
    const root = createInMemorySandbox().root;
    const foo = await makePath(root, 'libs/foo');
    await foo.createFile(
      'vite.config.ts',
      "export default { test: { include: ['src/**/*.test.ts'] }, build: { outDir: 'dist' } };"
    );

    expect(await discoverVitestProjectDirs('/root', root)).toEqual([foo.path]);
  });
});
