import { describe, it, expect } from 'vitest';
import { createInMemorySandbox } from '@minions/file-store';
import type { Directory } from '@minions/file-store';
import { syncPermissions } from '../src/PermissionsSync';
import type { AccessoriesPermissions } from '../src/AccessoriesConfig';

async function makeWorkLocalRoot(): Promise<Directory> {
  const sandbox = createInMemorySandbox();
  return sandbox.root;
}

async function readSettingsJson(workLocal: Directory): Promise<unknown> {
  const claudeResult = await workLocal.child('.claude');
  if (!claudeResult.found || claudeResult.node.kind !== 'directory') return null;
  const fileResult = await (claudeResult.node as Directory).child('settings.json');
  if (!fileResult.found || fileResult.node.kind !== 'file') return null;
  const text = await (fileResult.node as { read(): Promise<string> }).read();
  return JSON.parse(text);
}

describe('syncPermissions', () => {
  it('is a no-op when permissions is undefined', async () => {
    const workLocal = await makeWorkLocalRoot();
    // No settings.json exists
    await syncPermissions(workLocal, undefined);
    const result = await readSettingsJson(workLocal);
    expect(result).toBeNull();
  });

  it('does not touch settings.json when permissions is undefined (even if file exists)', async () => {
    const workLocal = await makeWorkLocalRoot();
    const claudeDir = await workLocal.createDirectory('.claude');
    const original = { someKey: 'someValue', permissions: { allow: ['OldTool'] } };
    await claudeDir.createFile('settings.json', JSON.stringify(original));

    await syncPermissions(workLocal, undefined);

    const result = await readSettingsJson(workLocal);
    expect(result).toEqual(original);
  });

  it('writes permissions into settings.json, preserving other keys', async () => {
    const workLocal = await makeWorkLocalRoot();
    const claudeDir = await workLocal.createDirectory('.claude');
    await claudeDir.createFile(
      'settings.json',
      JSON.stringify({ someKey: 'preserved', otherKey: 42 })
    );

    const permissions: AccessoriesPermissions = { allow: ['Read'], deny: ['Write'] };
    await syncPermissions(workLocal, permissions);

    const result = await readSettingsJson(workLocal);
    expect(result).toEqual({
      someKey: 'preserved',
      otherKey: 42,
      permissions: { allow: ['Read'], deny: ['Write'] },
    });
  });

  it('replaces an existing permissions key in settings.json', async () => {
    const workLocal = await makeWorkLocalRoot();
    const claudeDir = await workLocal.createDirectory('.claude');
    await claudeDir.createFile(
      'settings.json',
      JSON.stringify({ permissions: { allow: ['OldTool'] }, other: 'kept' })
    );

    const permissions: AccessoriesPermissions = { allow: ['Read', 'Bash(git *)'], deny: [] };
    await syncPermissions(workLocal, permissions);

    const result = await readSettingsJson(workLocal);
    expect(result).toEqual({
      permissions: { allow: ['Read', 'Bash(git *)'], deny: [] },
      other: 'kept',
    });
  });

  it('creates settings.json if it does not exist when permissions is provided', async () => {
    const workLocal = await makeWorkLocalRoot();
    await workLocal.createDirectory('.claude');

    const permissions: AccessoriesPermissions = { allow: ['Read'] };
    await syncPermissions(workLocal, permissions);

    const result = await readSettingsJson(workLocal);
    expect(result).toEqual({ permissions: { allow: ['Read'] } });
  });

  it('creates .claude/ and settings.json if neither exist', async () => {
    const workLocal = await makeWorkLocalRoot();

    const permissions: AccessoriesPermissions = { deny: ['Write'] };
    await syncPermissions(workLocal, permissions);

    const result = await readSettingsJson(workLocal);
    expect(result).toEqual({ permissions: { deny: ['Write'] } });
  });
});
