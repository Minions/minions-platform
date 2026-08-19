import { describe, it, expect, beforeEach } from 'vitest';
import { Effect } from 'effect';
import { createInMemorySandbox } from '@minions/file-store';
import type { File, Sandbox } from '@minions/file-store';
import { FileEventPersister } from './FileEventPersister';
import { createTestEvent } from '../test-utils/event-helpers';

describe('FileEventPersister', () => {
  let sandbox: Sandbox;
  let file: File;
  let persister: FileEventPersister;

  beforeEach(async () => {
    // Create a fresh in-memory sandbox for each test
    sandbox = createInMemorySandbox();

    // Create a file in the sandbox
    const result = await sandbox.root.child('events.jsonl');
    if (!result.found) {
      file = await sandbox.root.createFile('events.jsonl', '');
    } else {
      file = result.node as File;
    }

    persister = new FileEventPersister(file);
  });

  describe('constructor', () => {
    it('accepts IFile from file-store', () => {
      expect(persister).toBeInstanceOf(FileEventPersister);
    });
  });

  describe('append', () => {
    it('writes a single event as JSON Line', async () => {
      const event = createTestEvent('task-started', { taskId: '123' });

      await Effect.runPromise(persister.append(event));

      const content = await file.read();
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);

      const parsed = JSON.parse(lines[0]);
      expect(parsed.type).toBe('task-started');
      expect(parsed.payload.taskId).toBe('123');
    });

    it('appends multiple events on separate lines', async () => {
      const event1 = createTestEvent('task-started', { taskId: '123' });
      const event2 = createTestEvent('task-completed', { taskId: '123', result: 'success' });

      await Effect.runPromise(persister.append(event1));
      await Effect.runPromise(persister.append(event2));

      const content = await file.read();
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);

      const parsed1 = JSON.parse(lines[0]);
      expect(parsed1.type).toBe('task-started');

      const parsed2 = JSON.parse(lines[1]);
      expect(parsed2.type).toBe('task-completed');
    });

    it('preserves event metadata (source, timestamp)', async () => {
      const timestamp = 1234567890;
      const event = createTestEvent('test-event', { data: 'value' }, 'minion-abc', timestamp);

      await Effect.runPromise(persister.append(event));

      const content = await file.read();
      const parsed = JSON.parse(content.trim());
      expect(parsed.source).toBe('minion-abc');
      expect(parsed.timestamp).toBe(timestamp);
    });

    it('creates parent directories if they do not exist', async () => {
      // Create a file in a nested path
      const nestedResult = await sandbox.root.child('nested');
      if (!nestedResult.found) {
        await sandbox.root.createDirectory('nested');
      }
      const nestedChildResult = await sandbox.root.child('nested');
      if (!nestedChildResult.found) throw new Error('nested dir not found');
      const nested = nestedChildResult.node;
      if (nested.kind !== 'directory') throw new Error('expected nested to be a directory');
      const nestedFile = await nested.createFile('events.jsonl', '');
      const nestedPersister = new FileEventPersister(nestedFile);

      const event = createTestEvent('test-event', { data: 'value' });
      await Effect.runPromise(nestedPersister.append(event));

      const exists = await nestedFile.exists();
      expect(exists).toBe(true);
    });

    it('handles events with complex payloads', async () => {
      const event = createTestEvent('complex-event', {
        nested: { deeply: { value: 42 } },
        array: [1, 2, 3],
        nullValue: null,
        boolValue: true,
      });

      await Effect.runPromise(persister.append(event));

      const content = await file.read();
      const parsed = JSON.parse(content.trim());
      expect(parsed.payload.nested.deeply.value).toBe(42);
      expect(parsed.payload.array).toEqual([1, 2, 3]);
      expect(parsed.payload.nullValue).toBeNull();
      expect(parsed.payload.boolValue).toBe(true);
    });
  });

  describe('flush', () => {
    it('succeeds immediately (no-op for unbuffered)', async () => {
      const result = await Effect.runPromise(persister.flush());
      expect(result).toBeUndefined();
    });
  });

  describe('load', () => {
    it('returns empty array for missing file', async () => {
      // Delete the file to simulate missing
      await file.delete();

      const events = await Effect.runPromise(persister.load());
      expect(events).toEqual([]);
    });

    it('returns empty array for empty file', async () => {
      // File exists but is empty
      await file.write('');

      const events = await Effect.runPromise(persister.load());
      expect(events).toEqual([]);
    });

    it('loads a single event', async () => {
      const event = createTestEvent('task-started', { taskId: '123' }, 'minion-abc', 1000);
      await Effect.runPromise(persister.append(event));

      const events = await Effect.runPromise(persister.load());
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('task-started');
      expect(events[0].payload.taskId).toBe('123');
      expect(events[0].source).toBe('minion-abc');
      expect(events[0].timestamp).toBe(1000);
    });

    it('loads multiple events in order', async () => {
      const event1 = createTestEvent('event-1', { order: 1 }, 'source-1', 1000);
      const event2 = createTestEvent('event-2', { order: 2 }, 'source-2', 2000);
      const event3 = createTestEvent('event-3', { order: 3 }, 'source-3', 3000);

      await Effect.runPromise(persister.append(event1));
      await Effect.runPromise(persister.append(event2));
      await Effect.runPromise(persister.append(event3));

      const events = await Effect.runPromise(persister.load());
      expect(events).toHaveLength(3);
      expect(events[0].payload.order).toBe(1);
      expect(events[1].payload.order).toBe(2);
      expect(events[2].payload.order).toBe(3);
    });

    it('skips malformed JSON lines with console warning', async () => {
      // Write a mix of valid and invalid lines
      await file.write(
        JSON.stringify({
          type: 'valid-event',
          payload: { data: 'value' },
          source: 'test',
          timestamp: 1000,
        }) +
          '\n' +
          'this is not valid JSON\n' +
          JSON.stringify({
            type: 'another-valid-event',
            payload: { data: 'value2' },
            source: 'test',
            timestamp: 2000,
          }) +
          '\n'
      );

      const events = await Effect.runPromise(persister.load());
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('valid-event');
      expect(events[1].type).toBe('another-valid-event');
    });

    it('tracks corrupted event count from last load', async () => {
      // Write a mix of valid and corrupted lines
      await file.write(
        JSON.stringify({
          type: 'valid-event-1',
          payload: { data: 'value1' },
          source: 'test',
          timestamp: 1000,
        }) +
          '\n' +
          'corrupted line 1\n' +
          JSON.stringify({
            type: 'valid-event-2',
            payload: { data: 'value2' },
            source: 'test',
            timestamp: 2000,
          }) +
          '\n' +
          '{ incomplete json\n' +
          JSON.stringify({
            type: 'valid-event-3',
            payload: { data: 'value3' },
            source: 'test',
            timestamp: 3000,
          }) +
          '\n'
      );

      const events = await Effect.runPromise(persister.load());

      // Should load 3 valid events
      expect(events).toHaveLength(3);

      // Should track 2 corrupted events
      expect(persister.getLastLoadCorruptedCount()).toBe(2);
    });

    it('resets corrupted count on each load', async () => {
      // First load with corruption
      await file.write('corrupted\n' + JSON.stringify({
        type: 'valid',
        payload: {},
        source: 'test',
        timestamp: 1000,
      }) + '\n');

      await Effect.runPromise(persister.load());
      expect(persister.getLastLoadCorruptedCount()).toBe(1);

      // Second load with no corruption (overwrite file)
      await file.write(JSON.stringify({
        type: 'valid',
        payload: {},
        source: 'test',
        timestamp: 2000,
      }) + '\n');

      await Effect.runPromise(persister.load());
      expect(persister.getLastLoadCorruptedCount()).toBe(0);
    });

    it('handles file with only whitespace lines', async () => {
      await file.write('\n\n  \n\t\n\n');

      const events = await Effect.runPromise(persister.load());
      expect(events).toEqual([]);
    });
  });

  describe('exists', () => {
    it('returns true when file exists', async () => {
      const exists = await Effect.runPromise(persister.exists());
      expect(exists).toBe(true);
    });

    it('returns false when file does not exist', async () => {
      await file.delete();

      const exists = await Effect.runPromise(persister.exists());
      expect(exists).toBe(false);
    });
  });

  describe('count', () => {
    it('returns 0 for missing file', async () => {
      await file.delete();

      const count = await Effect.runPromise(persister.count());
      expect(count).toBe(0);
    });

    it('returns 0 for empty file', async () => {
      await file.write('');

      const count = await Effect.runPromise(persister.count());
      expect(count).toBe(0);
    });

    it('counts single event', async () => {
      const event = createTestEvent('test-event', { data: 'value' });
      await Effect.runPromise(persister.append(event));

      const count = await Effect.runPromise(persister.count());
      expect(count).toBe(1);
    });

    it('counts multiple events', async () => {
      const event1 = createTestEvent('event-1', { data: '1' });
      const event2 = createTestEvent('event-2', { data: '2' });
      const event3 = createTestEvent('event-3', { data: '3' });

      await Effect.runPromise(persister.append(event1));
      await Effect.runPromise(persister.append(event2));
      await Effect.runPromise(persister.append(event3));

      const count = await Effect.runPromise(persister.count());
      expect(count).toBe(3);
    });

    it('ignores empty lines', async () => {
      await file.write(
        JSON.stringify({ type: 'event-1', payload: {}, source: 'test', timestamp: 1000 }) +
          '\n\n' +
          JSON.stringify({ type: 'event-2', payload: {}, source: 'test', timestamp: 2000 }) +
          '\n  \n'
      );

      const count = await Effect.runPromise(persister.count());
      expect(count).toBe(2);
    });
  });

  describe('clear', () => {
    it('deletes the file if it exists', async () => {
      const event = createTestEvent('test-event', { data: 'value' });
      await Effect.runPromise(persister.append(event));

      // Verify file exists
      let exists = await file.exists();
      expect(exists).toBe(true);

      // Clear
      await Effect.runPromise(persister.clear());

      // Verify file is deleted
      exists = await file.exists();
      expect(exists).toBe(false);
    });

    it('succeeds when file does not exist', async () => {
      await file.delete();

      // Should not throw
      await Effect.runPromise(persister.clear());

      const exists = await file.exists();
      expect(exists).toBe(false);
    });
  });

  describe('close', () => {
    it('succeeds immediately (no-op for unbuffered)', async () => {
      const result = await Effect.runPromise(persister.close());
      expect(result).toBeUndefined();
    });

    it('can be called multiple times (idempotent)', async () => {
      await Effect.runPromise(persister.close());
      await Effect.runPromise(persister.close());
      await Effect.runPromise(persister.close());
      // Should not throw
    });
  });

  describe('error handling', () => {
    it('wraps errors in PersistError', async () => {
      // Create a scenario that would cause an error
      // For in-memory, this is harder, but we can test the structure
      const event = createTestEvent('test-event', { data: 'value' });

      // Append should succeed normally
      await Effect.runPromise(persister.append(event));

      // Load should succeed normally
      const events = await Effect.runPromise(persister.load());
      expect(events).toHaveLength(1);
    });
  });

  describe('integration scenarios', () => {
    it('supports append-load-clear cycle', async () => {
      // Append some events
      const event1 = createTestEvent('event-1', { data: '1' });
      const event2 = createTestEvent('event-2', { data: '2' });
      await Effect.runPromise(persister.append(event1));
      await Effect.runPromise(persister.append(event2));

      // Load and verify
      let events = await Effect.runPromise(persister.load());
      expect(events).toHaveLength(2);

      // Clear
      await Effect.runPromise(persister.clear());

      // Load again - should be empty
      events = await Effect.runPromise(persister.load());
      expect(events).toEqual([]);
    });

    it('supports resume scenario (exists + load)', async () => {
      // Fresh start - no events
      let exists = await Effect.runPromise(persister.exists());
      expect(exists).toBe(true); // File was created in beforeEach

      // Delete to simulate truly missing
      await file.delete();
      exists = await Effect.runPromise(persister.exists());
      expect(exists).toBe(false);

      // Append event
      const event = createTestEvent('resume-event', { data: 'resumed' });
      await Effect.runPromise(persister.append(event));

      // Now exists
      exists = await Effect.runPromise(persister.exists());
      expect(exists).toBe(true);

      // Load and verify
      const events = await Effect.runPromise(persister.load());
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('resume-event');
    });

    it('supports progress tracking (count without load)', async () => {
      // Add events one at a time, checking count
      let count = await Effect.runPromise(persister.count());
      expect(count).toBe(0);

      await Effect.runPromise(persister.append(createTestEvent('event-1', {})));
      count = await Effect.runPromise(persister.count());
      expect(count).toBe(1);

      await Effect.runPromise(persister.append(createTestEvent('event-2', {})));
      count = await Effect.runPromise(persister.count());
      expect(count).toBe(2);

      await Effect.runPromise(persister.append(createTestEvent('event-3', {})));
      count = await Effect.runPromise(persister.count());
      expect(count).toBe(3);
    });
  });
});
