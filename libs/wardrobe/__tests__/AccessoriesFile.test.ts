import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemorySandbox } from '@minions/file-store';
import type { Directory } from '@minions/file-store';
import { readAccessoriesFile, writeAccessoriesFile } from '../src/AccessoriesFile';
import type { AccessoriesConfig } from '../src/AccessoriesConfig';

async function makeWingRoot(): Promise<Directory> {
  const sandbox = createInMemorySandbox();
  return sandbox.root;
}

describe('readAccessoriesFile', () => {
  it('returns null when .meta/ does not exist', async () => {
    const root = await makeWingRoot();
    expect(await readAccessoriesFile(root)).toBeNull();
  });

  it('returns null when .meta/ exists but accessories.json does not', async () => {
    const root = await makeWingRoot();
    await root.createDirectory('.meta');
    expect(await readAccessoriesFile(root)).toBeNull();
  });

  it('parses a valid accessories.json', async () => {
    const root = await makeWingRoot();
    const meta = await root.createDirectory('.meta');
    const config: AccessoriesConfig = { costumes: ['dev-and-check'] };
    await meta.createFile('accessories.json', JSON.stringify(config));
    expect(await readAccessoriesFile(root)).toEqual(config);
  });

  it('parses config with permissions', async () => {
    const root = await makeWingRoot();
    const meta = await root.createDirectory('.meta');
    const config: AccessoriesConfig = {
      costumes: ['dev-and-check'],
      permissions: { allow: ['Read'], deny: ['Write'] },
    };
    await meta.createFile('accessories.json', JSON.stringify(config));
    expect(await readAccessoriesFile(root)).toEqual(config);
  });

  it('returns null when the file contains invalid JSON', async () => {
    const root = await makeWingRoot();
    const meta = await root.createDirectory('.meta');
    await meta.createFile('accessories.json', 'not-json');
    expect(await readAccessoriesFile(root)).toBeNull();
  });

  it('returns null when parsed JSON does not match the schema', async () => {
    const root = await makeWingRoot();
    const meta = await root.createDirectory('.meta');
    await meta.createFile('accessories.json', '{"costumes": "bad"}');
    expect(await readAccessoriesFile(root)).toBeNull();
  });
});

describe('writeAccessoriesFile', () => {
  let root: Directory;

  beforeEach(async () => {
    root = await makeWingRoot();
  });

  it('creates .meta/accessories.json when .meta/ does not exist', async () => {
    const config: AccessoriesConfig = { costumes: ['dev-and-check'] };
    await writeAccessoriesFile(root, config);
    const result = await readAccessoriesFile(root);
    expect(result).toEqual(config);
  });

  it('creates .meta/accessories.json when .meta/ already exists', async () => {
    await root.createDirectory('.meta');
    const config: AccessoriesConfig = { costumes: ['surface-discomforts'] };
    await writeAccessoriesFile(root, config);
    expect(await readAccessoriesFile(root)).toEqual(config);
  });

  it('overwrites an existing accessories.json', async () => {
    const first: AccessoriesConfig = { costumes: ['dev-and-check'] };
    await writeAccessoriesFile(root, first);

    const second: AccessoriesConfig = { costumes: ['harden-api'], permissions: { allow: ['Read'] } };
    await writeAccessoriesFile(root, second);

    expect(await readAccessoriesFile(root)).toEqual(second);
  });

  it('writes valid JSON that round-trips through readAccessoriesFile', async () => {
    const config: AccessoriesConfig = {
      costumes: ['a', 'b'],
      permissions: { allow: ['Read', 'Bash(git *)'], deny: ['Write'] },
    };
    await writeAccessoriesFile(root, config);
    expect(await readAccessoriesFile(root)).toEqual(config);
  });
});
