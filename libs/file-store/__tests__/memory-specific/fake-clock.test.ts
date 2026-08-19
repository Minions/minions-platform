/**
 * In-Memory Fake Clock Tests
 *
 * InMemorySandbox has no real filesystem, so File.stat() reports a fake
 * modification time that advances by exactly 1000ms on every
 * write()/append()/create. These tests pin down that exact behavior (the
 * generic Sandbox contract only asserts mtime is non-decreasing, since real
 * disk mtime resolution can't promise an exact delta).
 */

import { describe, it, expect } from 'vitest';
import { InMemorySandbox } from '../../src/adapters/memory/InMemorySandbox.js';

describe('InMemorySandbox fake clock', () => {
  it('starts at 0 and advances by exactly 1000ms per write', async () => {
    const sandbox = new InMemorySandbox();
    expect(sandbox.now()).toBe(0);

    const file = await sandbox.root.createFile('test.txt', 'v1');
    expect(sandbox.now()).toBe(1000);
    expect((await file.stat()).mtimeMs).toBe(1000);

    await file.write('v2');
    expect(sandbox.now()).toBe(2000);
    expect((await file.stat()).mtimeMs).toBe(2000);

    await file.append('!');
    expect(sandbox.now()).toBe(3000);
    expect((await file.stat()).mtimeMs).toBe(3000);
  });

  it('does not advance the clock for reads or unrelated files', async () => {
    const sandbox = new InMemorySandbox();
    const a = await sandbox.root.createFile('a.txt', 'a');
    const clockAfterA = sandbox.now();

    await a.read();
    await a.exists();
    expect(sandbox.now()).toBe(clockAfterA);

    const b = await sandbox.root.createFile('b.txt', 'b');
    expect((await a.stat()).mtimeMs).toBe(clockAfterA);
    expect((await b.stat()).mtimeMs).toBeGreaterThan(clockAfterA);
  });

  it('the clock is shared across the whole sandbox, so tests can predict exact mtimes', async () => {
    const sandbox = new InMemorySandbox();
    const dir = await sandbox.root.createDirectory('sub');

    await sandbox.root.createFile('first.txt');
    const beforeSecond = sandbox.now();
    const second = await dir.createFile('second.txt');

    expect((await second.stat()).mtimeMs).toBe(beforeSecond + 1000);
  });
});
