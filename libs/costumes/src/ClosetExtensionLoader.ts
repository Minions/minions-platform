/**
 * Closet Extension Loader
 *
 * Loads a costume's CostumeExtensions (action groups + gadgets, with
 * per-endpoint mounting) from a fixed `extensions.ts`/`extensions.js` entry
 * point at the costume's root. Parallel to ClosetGadgetLoader, but a costume
 * has at most one extensions entry point (vs. many files in a `gadgets/`
 * directory), since CostumeExtensions is itself a container for zero or
 * more action groups and gadgets.
 *
 * The entry point must export a zero-arg `getExtensions` factory returning
 * a CostumeExtensions value — see libs/gadgets/src/CostumeExtensions.ts.
 */

import { resolve } from 'path';
import { pathToFileURL } from 'url';
import type { CostumeExtensions } from '@minions/gadgets';
import { isCostumeExtensions } from '@minions/gadgets';
import type { Wing, DirectoryLike, NodeKind } from '@minions/file-store';
import { getOverlaidCostumeDirectories } from '@minions/file-store';

/**
 * Check if a node kind represents a directory-like node (directory, junction, or worktree).
 */
function isDirectoryLikeKind(kind: NodeKind): boolean {
  return kind === 'directory' || kind === 'junction' || kind === 'worktree';
}

/**
 * Extension entry point discovery result (lightweight, without loading)
 */
export interface ExtensionInfo {
  /** Costume name */
  costume: string;
  /** Path to the extensions entry point file */
  path: string;
}

/**
 * Loaded costume extensions with metadata
 */
export interface LoadedCostumeExtensions {
  /** The costume's declared extensions */
  extensions: CostumeExtensions;
  /** Costume name this extensions module belongs to */
  costumeName: string;
  /** Path to the extensions entry point file */
  path: string;
}

/**
 * Options for creating a ClosetExtensionLoader
 *
 * Provide either `wing` (for lair+wing overlay) or `closetDir` (for direct scanning).
 */
export interface ClosetExtensionLoaderOptions {
  /** Wing object for accessing the closet (lair + wing overlay) */
  wing?: Wing;
  /** Direct closet directory to scan (no overlay) */
  closetDir?: DirectoryLike;
}

/**
 * Loads a costume's CostumeExtensions from the closet (installed costumes)
 *
 * The ClosetExtensionLoader looks for a fixed `extensions.ts`/`extensions.js`
 * entry point at each costume's root and loads it via dynamic import, same
 * file:// URL technique ClosetGadgetLoader uses for `gadgets/*.ts`.
 *
 * @example
 * ```typescript
 * const loader = new ClosetExtensionLoader({ wing });
 *
 * // Discover all costumes that declare extensions
 * const infos = await loader.discover();
 *
 * // Load a specific costume's extensions
 * const loaded = await loader.load('my-costume');
 * ```
 */
export class ClosetExtensionLoader {
  private readonly wing?: Wing;
  private readonly closetDir?: DirectoryLike;
  private costumeMap: Map<string, DirectoryLike> | null = null;

  constructor(options: ClosetExtensionLoaderOptions) {
    if (!options.wing && !options.closetDir) {
      throw new Error('ClosetExtensionLoader requires either wing or closetDir');
    }
    this.wing = options.wing;
    this.closetDir = options.closetDir;
  }

  /**
   * Gets the costume map, initializing it on first access.
   * Uses wing overlay if wing is provided, otherwise scans closetDir directly.
   */
  private async getCostumeMap(): Promise<Map<string, DirectoryLike>> {
    if (this.costumeMap) {
      return this.costumeMap;
    }

    if (this.wing) {
      this.costumeMap = await getOverlaidCostumeDirectories(this.wing);
    } else {
      // Direct closet scanning — enumerate directory children
      const closetDir = this.closetDir;
      if (!closetDir) {
        throw new Error('ClosetExtensionLoader: closetDir is required when wing is not provided');
      }
      this.costumeMap = new Map<string, DirectoryLike>();
      const children = await closetDir.children();
      for (const child of children) {
        if (isDirectoryLikeKind(child.kind)) {
          this.costumeMap.set(child.name, child as DirectoryLike);
        }
      }
    }

    return this.costumeMap;
  }

  /**
   * Finds the extensions entry point file (`extensions.ts`, else `extensions.js`)
   * directly under a costume's root directory, or null if neither exists.
   */
  private async findExtensionsFile(costumeDir: DirectoryLike): Promise<string | null> {
    const tsResult = await costumeDir.child('extensions.ts');
    if (tsResult.found && tsResult.node.kind === 'file') {
      return tsResult.node.path;
    }

    const jsResult = await costumeDir.child('extensions.js');
    if (jsResult.found && jsResult.node.kind === 'file') {
      return jsResult.node.path;
    }

    return null;
  }

  /**
   * Discover all costumes that declare an extensions entry point
   */
  async discover(): Promise<ExtensionInfo[]> {
    const infos: ExtensionInfo[] = [];

    try {
      const costumeMap = await this.getCostumeMap();

      for (const [costume, costumeDir] of costumeMap) {
        const path = await this.findExtensionsFile(costumeDir);
        if (path) {
          infos.push({ costume, path });
        }
      }
    } catch (error) {
      console.error(
        '[ClosetExtensionLoader] Failed to discover extensions:',
        error instanceof Error ? error.message : String(error)
      );
      return [];
    }

    return infos;
  }

  /**
   * Load a specific costume's extensions
   */
  async load(costume: string): Promise<LoadedCostumeExtensions> {
    const costumeMap = await this.getCostumeMap();
    const costumeDir = costumeMap.get(costume);
    if (!costumeDir) {
      throw new Error(`Extensions not found: ${costume}. Costume not found.`);
    }

    const path = await this.findExtensionsFile(costumeDir);
    if (!path) {
      throw new Error(
        `Extensions not found: ${costume}. Checked: extensions.ts, extensions.js`
      );
    }

    return this.loadExtensionsFile(costume, path);
  }

  /**
   * Load extensions for all costumes that declare them
   *
   * Convenience method that discovers and loads all extensions. Errors
   * loading individual costumes' extensions are logged and skipped.
   */
  async loadAll(): Promise<LoadedCostumeExtensions[]> {
    const infos = await this.discover();
    const loaded: LoadedCostumeExtensions[] = [];

    for (const info of infos) {
      try {
        const result = await this.load(info.costume);
        loaded.push(result);
      } catch (error) {
        console.error(
          `[ClosetExtensionLoader] Failed to load extensions for costume "${info.costume}":`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    return loaded;
  }

  /**
   * Check if a costume declares an extensions entry point
   */
  async exists(costume: string): Promise<boolean> {
    try {
      const costumeMap = await this.getCostumeMap();
      const costumeDir = costumeMap.get(costume);
      if (!costumeDir) {
        return false;
      }

      const path = await this.findExtensionsFile(costumeDir);
      return path !== null;
    } catch (error) {
      console.error(
        `[ClosetExtensionLoader] Failed to check extensions for costume "${costume}":`,
        error instanceof Error ? error.message : String(error)
      );
      return false;
    }
  }

  private async loadExtensionsFile(costume: string, path: string): Promise<LoadedCostumeExtensions> {
    const absolutePath = resolve(path);
    const moduleUrl = pathToFileURL(absolutePath).href;
    const module = await import(moduleUrl);

    const factory = module.getExtensions as unknown;
    if (typeof factory !== 'function') {
      throw new Error(
        `Invalid extensions export: ${costume}. ` +
        `Expected 'export function getExtensions(): CostumeExtensions' but got ${typeof factory}`
      );
    }

    const extensions = (factory as () => unknown)();
    if (!isCostumeExtensions(extensions)) {
      throw new Error(
        `Invalid extensions shape: ${costume}. getExtensions() did not return a valid CostumeExtensions.`
      );
    }

    return {
      extensions,
      costumeName: costume,
      path,
    };
  }
}
