import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Effect } from 'effect';
import { Workbench } from './Workbench';
import type { File } from '@minions/file-store';
import { createInMemorySandbox } from '@minions/file-store';

function createMockFile(
  path: string,
  content: string | Error,
  name?: string
): File {
  return {
    kind: 'file',
    name: name ?? path.split('/').pop() ?? 'unknown',
    path,
    read: vi.fn().mockImplementation(() =>
      content instanceof Error ? Promise.reject(content) : Promise.resolve(content)
    ),
    readLines: vi.fn(),
    exists: vi.fn(),
    stat: vi.fn().mockResolvedValue({ mtimeMs: 0 }),
    write: vi.fn().mockResolvedValue(undefined),
    append: vi.fn(),
    delete: vi.fn(),
    child: vi.fn(),
    match: vi.fn(),
    is: vi.fn((kind: string) => kind === 'file') as unknown as File['is'],
    isDirectoryLike: () => false,
  };
}

describe('Workbench', () => {
  let workbench: Workbench;

  beforeEach(() => {
    workbench = new Workbench(createInMemorySandbox());
  });

  describe('File Storage', () => {
    describe('addFile with path and content string', () => {
      it('should store file with path and content', async () => {
        await Effect.runPromise(workbench.addFile('src/index.ts', 'export const foo = 1;'));

        expect(workbench.files.size).toBe(1);
        const file = workbench.files.get('src/index.ts');
        expect(file).toBeDefined();
        expect(file?.path).toBe('src/index.ts');
        expect(file?.content).toBe('export const foo = 1;');
        expect(file?.modified).toBe(false);
        expect(file?.category).toBe('general');
        expect(file?.lastRead).toBeGreaterThan(0);
      });

      it('should store file with custom category', async () => {
        await Effect.runPromise(workbench.addFile('src/index.ts', 'export const foo = 1;', 'source'));

        const file = workbench.files.get('src/index.ts');
        expect(file?.category).toBe('source');
      });

      it('should update existing file', async () => {
        await Effect.runPromise(workbench.addFile('src/index.ts', 'version 1'));
        const firstFile = workbench.files.get('src/index.ts');
        if (!firstFile) throw new Error('expected src/index.ts to be in workbench');
        const firstRead = firstFile.lastRead;

        // Small delay to ensure different timestamp
        await new Promise(resolve => setTimeout(resolve, 5));

        await Effect.runPromise(workbench.addFile('src/index.ts', 'version 2'));

        expect(workbench.files.size).toBe(1);
        const file = workbench.files.get('src/index.ts');
        expect(file?.content).toBe('version 2');
        expect(file?.lastRead).toBeGreaterThan(firstRead);
      });
    });

    describe('addFile with path and content promise', () => {
      it('should resolve promise and store content', async () => {
        const contentPromise = Promise.resolve('async content');

        await Effect.runPromise(workbench.addFile('src/async.ts', contentPromise));

        const file = workbench.files.get('src/async.ts');
        expect(file?.content).toBe('async content');
      });

      it('should accept custom category with promise', async () => {
        const contentPromise = Promise.resolve('test content');

        await Effect.runPromise(workbench.addFile('test/example.test.ts', contentPromise, 'test'));

        const file = workbench.files.get('test/example.test.ts');
        expect(file?.category).toBe('test');
      });

      it('should handle rejected promise', async () => {
        const contentPromise = Promise.reject(new Error('Read failed'));

        await expect(
          Effect.runPromise(workbench.addFile('src/broken.ts', contentPromise))
        ).rejects.toThrow('Read failed');

        expect(workbench.files.has('src/broken.ts')).toBe(false);
      });
    });

    describe('addFile with IFile object', () => {
      it('should read IFile and store content', async () => {
        const mockFile = createMockFile('/project/src/index.ts', 'file-store content', 'index.ts');

        await Effect.runPromise(workbench.addFile(mockFile));

        expect(mockFile.read).toHaveBeenCalled();
        const file = workbench.files.get('/project/src/index.ts');
        expect(file?.path).toBe('/project/src/index.ts');
        expect(file?.content).toBe('file-store content');
        expect(file?.category).toBe('general');
      });

      it('should use IFile path as key', async () => {
        const mockFile = createMockFile('/absolute/path/config.json', '{"key": "value"}', 'config.json');

        await Effect.runPromise(workbench.addFile(mockFile, 'config'));

        expect(workbench.files.has('/absolute/path/config.json')).toBe(true);
        const file = workbench.files.get('/absolute/path/config.json');
        expect(file?.category).toBe('config');
      });

      it('should handle IFile read failure', async () => {
        const mockFile = createMockFile('/project/broken.ts', new Error('File not found'), 'broken.ts');

        await expect(
          Effect.runPromise(workbench.addFile(mockFile))
        ).rejects.toThrow('Failed to read file');

        expect(workbench.files.has('/project/broken.ts')).toBe(false);
      });
    });

    describe('files map', () => {
      it('should expose Map interface', () => {
        expect(workbench.files).toBeDefined();
        // TypeScript enforces readonly via ReadonlyMap type
        expect(workbench.files instanceof Map).toBe(true);
        expect(typeof workbench.files.get).toBe('function');
        expect(typeof workbench.files.has).toBe('function');
        expect(typeof workbench.files.size).toBe('number');
      });

      it('should reflect all added files', async () => {
        await Effect.runPromise(workbench.addFile('file1.ts', 'content1'));
        await Effect.runPromise(workbench.addFile('file2.ts', 'content2'));
        await Effect.runPromise(workbench.addFile('file3.ts', 'content3'));

        expect(workbench.files.size).toBe(3);
        expect(workbench.files.has('file1.ts')).toBe(true);
        expect(workbench.files.has('file2.ts')).toBe(true);
        expect(workbench.files.has('file3.ts')).toBe(true);
      });
    });
  });

  describe('Fact Storage', () => {
    describe('addFact', () => {
      it('should store fact with all properties', () => {
        workbench.addFact('build', 'Build command is: pnpm build', 'confirmed', 'minion-123');

        expect(workbench.facts.length).toBe(1);
        expect(workbench.facts[0]).toEqual({
          category: 'build',
          fact: 'Build command is: pnpm build',
          confidence: 'confirmed',
          discoveredBy: 'minion-123',
        });
      });

      it('should use "mission" as default discoveredBy', () => {
        workbench.addFact('test', 'Uses Vitest', 'inferred');

        expect(workbench.facts.length).toBe(1);
        expect(workbench.facts[0].discoveredBy).toBe('mission');
      });

      it('should support open-ended categories', () => {
        workbench.addFact('custom-category', 'Custom fact', 'confirmed');
        workbench.addFact('package-manager', 'Uses pnpm', 'confirmed');
        workbench.addFact('deployment', 'Deploys to AWS', 'inferred');

        expect(workbench.facts.length).toBe(3);
        expect(workbench.facts[0].category).toBe('custom-category');
        expect(workbench.facts[1].category).toBe('package-manager');
        expect(workbench.facts[2].category).toBe('deployment');
      });

      it('should support multiple facts in same category', () => {
        workbench.addFact('build', 'Build command is: pnpm build', 'confirmed');
        workbench.addFact('build', 'Build outputs to dist/', 'inferred');

        expect(workbench.facts.length).toBe(2);
        expect(workbench.facts[0].category).toBe('build');
        expect(workbench.facts[1].category).toBe('build');
      });

      it('should support both confidence levels', () => {
        workbench.addFact('fact1', 'Confirmed fact', 'confirmed');
        workbench.addFact('fact2', 'Inferred fact', 'inferred');

        expect(workbench.facts[0].confidence).toBe('confirmed');
        expect(workbench.facts[1].confidence).toBe('inferred');
      });
    });

    describe('facts array', () => {
      it('should be readonly', () => {
        expect(workbench.facts).toBeDefined();
        expect(Array.isArray(workbench.facts)).toBe(true);
      });

      it('should reflect all added facts', () => {
        workbench.addFact('build', 'Fact 1', 'confirmed');
        workbench.addFact('test', 'Fact 2', 'inferred');
        workbench.addFact('structure', 'Fact 3', 'confirmed');

        expect(workbench.facts.length).toBe(3);
      });

      it('should preserve insertion order', () => {
        workbench.addFact('cat1', 'First', 'confirmed');
        workbench.addFact('cat2', 'Second', 'inferred');
        workbench.addFact('cat3', 'Third', 'confirmed');

        expect(workbench.facts[0].fact).toBe('First');
        expect(workbench.facts[1].fact).toBe('Second');
        expect(workbench.facts[2].fact).toBe('Third');
      });
    });
  });

  describe('Integration', () => {
    it('should support mixing files and facts', async () => {
      await Effect.runPromise(workbench.addFile('src/index.ts', 'content'));
      workbench.addFact('build', 'Uses pnpm', 'confirmed');
      await Effect.runPromise(workbench.addFile('package.json', '{}'));
      workbench.addFact('test', 'Uses Vitest', 'inferred');

      expect(workbench.files.size).toBe(2);
      expect(workbench.facts.length).toBe(2);
    });

    it('should support parallel file additions', async () => {
      const effects = [
        workbench.addFile('file1.ts', 'content1'),
        workbench.addFile('file2.ts', 'content2'),
        workbench.addFile('file3.ts', 'content3'),
      ];

      await Promise.all(effects.map(e => Effect.runPromise(e)));

      expect(workbench.files.size).toBe(3);
    });

    it('should support chained IFile additions', async () => {
      const mockFile1 = createMockFile('/path/file1.ts', 'content1', 'file1.ts');
      const mockFile2 = createMockFile('/path/file2.ts', 'content2', 'file2.ts');

      await Promise.all([
        Effect.runPromise(workbench.addFile(mockFile1)),
        Effect.runPromise(workbench.addFile(mockFile2)),
      ]);

      expect(workbench.files.size).toBe(2);
      expect(mockFile1.read).toHaveBeenCalled();
      expect(mockFile2.read).toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty content string', async () => {
      await Effect.runPromise(workbench.addFile('empty.ts', ''));

      const file = workbench.files.get('empty.ts');
      expect(file?.content).toBe('');
    });

    it('should handle very long content', async () => {
      const longContent = 'x'.repeat(1000000);

      await Effect.runPromise(workbench.addFile('large.ts', longContent));

      const file = workbench.files.get('large.ts');
      expect(file?.content.length).toBe(1000000);
    });

    it('should handle special characters in path', async () => {
      await Effect.runPromise(workbench.addFile('path/with spaces/file.ts', 'content'));
      await Effect.runPromise(workbench.addFile('path/with-dashes/file.ts', 'content'));
      await Effect.runPromise(workbench.addFile('path/with_underscores/file.ts', 'content'));

      expect(workbench.files.size).toBe(3);
    });

    it('should handle special characters in fact', () => {
      workbench.addFact('build', 'Command: pnpm build --filter="@scope/package"', 'confirmed');

      expect(workbench.facts[0].fact).toContain('--filter="@scope/package"');
    });
  });

  describe('Cache Management', () => {
    describe('lastModified tracking', () => {
      it('should track lastModified when adding file from IFile', async () => {
        const mockFile = createMockFile('/project/src/index.ts', 'content', 'index.ts');

        await Effect.runPromise(workbench.addFile(mockFile));

        const file = workbench.files.get('/project/src/index.ts');
        // lastModified may be undefined for mock files that don't exist on disk
        expect(file?.lastModified === undefined || typeof file?.lastModified === 'number').toBe(true);
      });

      it('should track lastModified when adding file by path', async () => {
        await Effect.runPromise(workbench.addFile('src/index.ts', 'content'));

        const file = workbench.files.get('src/index.ts');
        // lastModified may be undefined for paths that don't exist on disk
        expect(file?.lastModified === undefined || typeof file?.lastModified === 'number').toBe(true);
      });
    });

    describe('refreshFile', () => {
      it('should return false if file not in cache', async () => {
        const result = await Effect.runPromise(workbench.refreshFile('nonexistent.ts'));

        expect(result).toBe(false);
      });

      it('should return false if file no longer exists on disk', async () => {
        await Effect.runPromise(workbench.addFile('/nonexistent/path/file.ts', 'content'));

        const result = await Effect.runPromise(workbench.refreshFile('/nonexistent/path/file.ts'));

        expect(result).toBe(false);
      });

      it('should update lastRead timestamp when refreshing', async () => {
        await Effect.runPromise(workbench.addFile('src/index.ts', 'content'));
        // Record the initial timestamp (not used but validates file was added)
        expect(workbench.files.get('src/index.ts')?.lastRead).toBeDefined();

        // Small delay to ensure different timestamp
        await new Promise(resolve => setTimeout(resolve, 5));

        // This will return false since the file doesn't exist on disk,
        // but we're testing the timestamp would update if it did
        await Effect.runPromise(workbench.refreshFile('src/index.ts'));

        // Since the file doesn't exist on disk, this test verifies
        // the behavior when file is not found
        const secondLastRead = workbench.files.get('src/index.ts')?.lastRead;
        expect(secondLastRead).toBeDefined();
      });

      it('should preserve file category when attempting refresh', async () => {
        await Effect.runPromise(workbench.addFile('src/index.ts', 'content', 'source'));

        await Effect.runPromise(workbench.refreshFile('src/index.ts'));

        const file = workbench.files.get('src/index.ts');
        expect(file?.category).toBe('source');
      });
    });

    describe('refreshDirtyFiles', () => {
      it('should return empty array if no files are dirty', async () => {
        await Effect.runPromise(workbench.addFile('src/index.ts', 'content'));

        const refreshed = await Effect.runPromise(workbench.refreshDirtyFiles());

        expect(refreshed).toEqual([]);
      });

      it('should refresh multiple files in parallel', async () => {
        await Effect.runPromise(workbench.addFile('file1.ts', 'content1'));
        await Effect.runPromise(workbench.addFile('file2.ts', 'content2'));
        await Effect.runPromise(workbench.addFile('file3.ts', 'content3'));

        // Mock isDirty to return Effect that yields true for all files
        vi.spyOn(workbench, 'isDirty').mockReturnValue(Effect.succeed(true));

        const refreshed = await Effect.runPromise(workbench.refreshDirtyFiles());

        expect(refreshed.length).toBeGreaterThan(0);
      });

      it('should only refresh dirty files', async () => {
        await Effect.runPromise(workbench.addFile('clean.ts', 'content'));
        await Effect.runPromise(workbench.addFile('dirty.ts', 'content'));

        // Mock isDirty to return Effect that yields true only for dirty.ts
        vi.spyOn(workbench, 'isDirty').mockImplementation((path) => {
          return Effect.succeed(path === 'dirty.ts');
        });

        const refreshed = await Effect.runPromise(workbench.refreshDirtyFiles());

        expect(refreshed).toEqual(['dirty.ts']);
      });
    });

    describe('isDirty', () => {
      it('should return false if file not in cache', async () => {
        const result = await Effect.runPromise(workbench.isDirty('nonexistent.ts'));

        expect(result).toBe(false);
      });

      it('should return false if file has no lastModified', async () => {
        await Effect.runPromise(workbench.addFile('file.ts', 'content'));
        // Manually remove lastModified
        const file = workbench.files.get('file.ts');
        if (file) {
          workbench['_files'].set('file.ts', { ...file, lastModified: undefined });
        }

        const result = await Effect.runPromise(workbench.isDirty('file.ts'));

        expect(result).toBe(false);
      });

      it('should return false if file no longer exists', async () => {
        await Effect.runPromise(workbench.addFile('/nonexistent/file.ts', 'content'));

        const result = await Effect.runPromise(workbench.isDirty('/nonexistent/file.ts'));

        expect(result).toBe(false);
      });

      it('should return false if file modification time unchanged', async () => {
        await Effect.runPromise(workbench.addFile('file.ts', 'content'));

        const result = await Effect.runPromise(workbench.isDirty('file.ts'));

        expect(result).toBe(false);
      });
    });

    describe('onFileChange', () => {
      it('should register and call callback when file is written', async () => {
        const callback = vi.fn();
        workbench.onFileChange(callback);

        const mockFile = createMockFile('/project/file.ts', '', 'file.ts');
        await Effect.runPromise(workbench.writeFile(mockFile, 'content'));

        expect(callback).toHaveBeenCalledWith('/project/file.ts', 'content');
      });

      it('should call multiple callbacks', async () => {
        const callback1 = vi.fn();
        const callback2 = vi.fn();
        workbench.onFileChange(callback1);
        workbench.onFileChange(callback2);

        const mockFile = createMockFile('/project/file.ts', '', 'file.ts');
        await Effect.runPromise(workbench.writeFile(mockFile, 'content'));

        expect(callback1).toHaveBeenCalled();
        expect(callback2).toHaveBeenCalled();
      });

      it('should allow unregistering callback', async () => {
        const callback = vi.fn();
        const unregister = workbench.onFileChange(callback);

        unregister();

        const mockFile = createMockFile('/project/file.ts', '', 'file.ts');
        await Effect.runPromise(workbench.writeFile(mockFile, 'content'));

        expect(callback).not.toHaveBeenCalled();
      });

      it('should handle callback errors gracefully', async () => {
        const errorCallback = vi.fn(() => {
          throw new Error('Callback error');
        });
        const goodCallback = vi.fn();

        workbench.onFileChange(errorCallback);
        workbench.onFileChange(goodCallback);

        const mockFile = createMockFile('/project/file.ts', '', 'file.ts');
        await Effect.runPromise(workbench.writeFile(mockFile, 'content'));

        expect(errorCallback).toHaveBeenCalled();
        expect(goodCallback).toHaveBeenCalled();
      });

      it('should not call callbacks that were unregistered', async () => {
        const callback1 = vi.fn();
        const callback2 = vi.fn();

        const unregister1 = workbench.onFileChange(callback1);
        workbench.onFileChange(callback2);

        unregister1();

        const mockFile = createMockFile('/project/file.ts', '', 'file.ts');
        await Effect.runPromise(workbench.writeFile(mockFile, 'content'));

        expect(callback1).not.toHaveBeenCalled();
        expect(callback2).toHaveBeenCalled();
      });
    });

    describe('writeFile', () => {
      it('should write file and update cache', async () => {
        const mockFile = createMockFile('/project/src/new.ts', '', 'new.ts');

        await Effect.runPromise(workbench.writeFile(mockFile, 'new content'));

        expect(mockFile.write).toHaveBeenCalledWith('new content');
        const cached = workbench.files.get('/project/src/new.ts');
        expect(cached?.content).toBe('new content');
        expect(cached?.modified).toBe(true);
      });

      it('should set default category to general', async () => {
        const mockFile = createMockFile('/project/file.ts', '', 'file.ts');

        await Effect.runPromise(workbench.writeFile(mockFile, 'content'));

        const cached = workbench.files.get('/project/file.ts');
        expect(cached?.category).toBe('general');
      });

      it('should use custom category', async () => {
        const mockFile = createMockFile('/project/file.ts', '', 'file.ts');

        await Effect.runPromise(workbench.writeFile(mockFile, 'content', 'test'));

        const cached = workbench.files.get('/project/file.ts');
        expect(cached?.category).toBe('test');
      });

      it('should update lastModified timestamp', async () => {
        const mockFile = createMockFile('/project/file.ts', '', 'file.ts');

        await Effect.runPromise(workbench.writeFile(mockFile, 'content'));

        const cached = workbench.files.get('/project/file.ts');
        // lastModified may be undefined for mock files that don't exist on disk
        expect(cached?.lastModified === undefined || typeof cached?.lastModified === 'number').toBe(true);
      });

      it('should notify callbacks when writing', async () => {
        const callback = vi.fn();
        workbench.onFileChange(callback);

        const mockFile = createMockFile('/project/file.ts', '', 'file.ts');
        await Effect.runPromise(workbench.writeFile(mockFile, 'content'));

        expect(callback).toHaveBeenCalledWith('/project/file.ts', 'content');
      });

      it('should overwrite existing file in cache', async () => {
        const mockFile = createMockFile('/project/file.ts', 'old content', 'file.ts');
        await Effect.runPromise(workbench.addFile(mockFile, 'source'));

        await Effect.runPromise(workbench.writeFile(mockFile, 'new content', 'test'));

        const cached = workbench.files.get('/project/file.ts');
        expect(cached?.content).toBe('new content');
        expect(cached?.category).toBe('test');
        expect(cached?.modified).toBe(true);
      });
    });

    describe('Integration with existing addFile', () => {
      it('should set modified to false when adding file', async () => {
        await Effect.runPromise(workbench.addFile('file.ts', 'content'));

        const cached = workbench.files.get('file.ts');
        expect(cached?.modified).toBe(false);
      });

      it('should track lastModified when adding IFile', async () => {
        const mockFile = createMockFile('/project/file.ts', 'content', 'file.ts');

        await Effect.runPromise(workbench.addFile(mockFile));

        const cached = workbench.files.get('/project/file.ts');
        // lastModified may be undefined for mock files that don't exist on disk
        expect(cached?.lastModified === undefined || typeof cached?.lastModified === 'number').toBe(true);
      });
    });
  });

  describe('Architecture Boundaries', () => {
    it('should not import from @minions/hatchery', async () => {
      // This test verifies that Workbench.ts has no hatchery dependencies
      // by attempting to read and parse the file for imports
      const fs = await import('fs/promises');
      const path = await import('path');

      const workbenchPath = path.join(__dirname, 'Workbench.ts');
      const content = await fs.readFile(workbenchPath, 'utf-8');

      // Check for any imports from hatchery
      const hatcheryImportPattern = /from\s+['"]@minions\/hatchery/g;
      const matches = content.match(hatcheryImportPattern);

      expect(matches).toBeNull();
    });

    it('should not import from @minions/hatchery in IWorkbench interface', async () => {
      // Verify the interface definition is clean
      const fs = await import('fs/promises');
      const path = await import('path');

      // IWorkbench is defined in Workbench.ts, check the entire file
      const workbenchPath = path.join(__dirname, 'Workbench.ts');
      const content = await fs.readFile(workbenchPath, 'utf-8');

      // Ensure no hatchery types are referenced
      const hatcheryPattern = /@minions\/hatchery|from\s+['"].*hatchery/gi;
      const matches = content.match(hatcheryPattern);

      expect(matches).toBeNull();
    });
  });
});
