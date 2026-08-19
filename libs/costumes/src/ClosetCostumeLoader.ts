import { Effect, Data } from 'effect';
import { resolve, dirname, join } from 'path';
import { pathToFileURL } from 'url';
import type { Costume } from './Costume';
import { isCostume } from './Costume';
import type { CostumeConfig } from './CostumeConfig';
import { isCostumeConfig } from './CostumeConfig';
import { isCostumeEventDef } from './CostumeEventDef';
import type { Wing, DirectoryLike } from '@minions/file-store';
import { getOverlaidCostumeDirectories } from '@minions/file-store';

/**
 * Costume loading failed
 */
export class LoadError extends Data.TaggedError('LoadError')<{
  reason: string;
  costumeName?: string;
  path?: string;
}> {}

/**
 * Options for creating a ClosetCostumeLoader
 */
export interface ClosetCostumeLoaderOptions {
  /**
   * Wing object for accessing the closet
   */
  wing: Wing;
}

/**
 * Loads costume definitions from the closet (installed costumes)
 *
 * The ClosetCostumeLoader scans costume directories for costume.ts files
 * and loads them via dynamic import. It also loads prompt.md files if present.
 *
 * The closet is accessed via the Wing.closet() method or Wing.root().child('closet').
 *
 * @example
 * ```typescript
 * // Create loader with Wing dependency
 * const loader = new ClosetCostumeLoader({ wing });
 *
 * // Discover all costumes
 * const costumes = await Effect.runPromise(loader.discover());
 *
 * // Load a specific costume
 * const costume = await Effect.runPromise(loader.load('developer'));
 * ```
 */
export class ClosetCostumeLoader {
  private readonly wing: Wing;
  private costumeMap: Map<string, DirectoryLike> | null = null;

  constructor(options: ClosetCostumeLoaderOptions) {
    this.wing = options.wing;
  }

  /**
   * Gets the overlaid costume map, initializing it on first access.
   * Lair costumes are the base, wing costumes override by name.
   */
  private async getCostumeMap(): Promise<Map<string, DirectoryLike>> {
    if (this.costumeMap) {
      return this.costumeMap;
    }

    this.costumeMap = await getOverlaidCostumeDirectories(this.wing);
    return this.costumeMap;
  }

  /**
   * Discover all available costumes in the closet
   *
   * Returns a list of costume names from the overlaid lair + wing closets.
   * Handles missing closets gracefully by returning an empty array.
   *
   * @returns Effect that resolves to array of costume names
   */
  discover(): Effect.Effect<string[], LoadError, never> {
    return Effect.tryPromise({
      try: async () => {
        try {
          const costumeMap = await this.getCostumeMap();
          return Array.from(costumeMap.keys());
        } catch (error) {
          console.error(
            '[ClosetCostumeLoader] Failed to discover costumes:',
            error instanceof Error ? error.message : String(error)
          );
          return [];
        }
      },
      catch: (error) => {
        return new LoadError({
          reason: `Failed to discover costumes: ${error instanceof Error ? error.message : String(error)}`,
        });
      },
    });
  }

  /**
   * Load a specific costume by name
   *
   * Checks for costume.json first, then falls back to costume.ts.
   * If a prompt.md file exists alongside it, loads it and sets as systemPrompt.
   *
   * @param costumeName - Name of the costume to load
   * @returns Effect that resolves to the loaded Costume
   */
  load(costumeName: string): Effect.Effect<Costume, LoadError, never> {
    return Effect.tryPromise({
      try: async () => {
        const costumeMap = await this.getCostumeMap();
        const costumeDir = costumeMap.get(costumeName);
        if (!costumeDir) {
          throw new Error(
            `Costume not found: ${costumeName}. Not in lair or wing closet.`
          );
        }

        // Try costume.json first (preferred)
        const jsonResult = await costumeDir.child('costume.json');
        if (jsonResult.found && jsonResult.node.kind === 'file') {
          return this.loadFromJson(costumeName, costumeDir, jsonResult.node.path);
        }

        // Fall back to costume.ts (deprecated)
        const tsResult = await costumeDir.child('costume.ts');
        if (tsResult.found && tsResult.node.kind === 'file') {
          console.warn(
            `[ClosetCostumeLoader] costume.ts is deprecated, use costume.json instead: ${costumeName}`
          );
          return this.loadFromTs(costumeName, costumeDir, tsResult.node.path);
        }

        throw new Error(
          `Costume not found: ${costumeName}. Expected costume.json file.`
        );
      },
      catch: (error) => {
        return new LoadError({
          reason: error instanceof Error ? error.message : String(error),
          costumeName,
        });
      },
    });
  }

  /**
   * Load costume from a costume.json file
   */
  private async loadFromJson(
    costumeName: string,
    costumeDir: DirectoryLike,
    jsonPath: string
  ): Promise<Costume> {
    const jsonFileResult = await costumeDir.child('costume.json');
    if (!jsonFileResult.found || jsonFileResult.node.kind !== 'file') {
      throw new Error(`Cannot read costume.json for ${costumeName}`);
    }

    const content = await jsonFileResult.node.read();
    let config: unknown;
    try {
      config = JSON.parse(content);
    } catch {
      throw new Error(`Invalid JSON in costume.json for ${costumeName}`);
    }

    if (!isCostumeConfig(config)) {
      throw new Error(
        `Invalid costume config: ${costumeName}. costume.json failed validation.`
      );
    }

    const typedConfig = config as CostumeConfig;
    const costumeBasePath = dirname(resolve(jsonPath));

    // Resolve system prompt
    let systemPrompt = typedConfig.systemPrompt;

    // systemPromptFile takes precedence over inline systemPrompt
    if (typedConfig.systemPromptFile) {
      const promptResult = await costumeDir.child(typedConfig.systemPromptFile);
      if (promptResult.found && promptResult.node.kind === 'file') {
        systemPrompt = await promptResult.node.read();
      }
    }

    // Also check for prompt.md (convention)
    if (!systemPrompt) {
      const promptMdResult = await costumeDir.child('prompt.md');
      if (promptMdResult.found && promptMdResult.node.kind === 'file') {
        systemPrompt = await promptMdResult.node.read();
      }
    }

    // Resolve event entrypoints into CostumeEvent objects
    const events = await this.resolveEvents(costumeName, costumeBasePath, typedConfig);

    return {
      model: typedConfig.model,
      systemPrompt,
      gadgets: [],  // Gadgets are loaded separately by ClosetExtensionLoader
      skills: [],
      events,
      injectFacts: typedConfig.injectFacts,
    };
  }

  /**
   * Load costume from a costume.ts file (deprecated)
   */
  private async loadFromTs(
    costumeName: string,
    costumeDir: DirectoryLike,
    tsPath: string
  ): Promise<Costume> {
    const costumePath = resolve(tsPath);
    const module = await dynamicImport(costumePath);

    const costume = module.costume as unknown;
    if (!isCostume(costume)) {
      throw new Error(
        `Invalid costume export: ${costumeName}. ` +
        `Expected 'export const costume: Costume' but got ${typeof costume}`
      );
    }

    // Load prompt.md if it exists
    let systemPrompt = costume.systemPrompt;
    const promptFileResult = await costumeDir.child('prompt.md');
    if (promptFileResult.found && promptFileResult.node.kind === 'file') {
      const promptContent = await promptFileResult.node.read();
      systemPrompt = promptContent;
    }

    return {
      ...costume,
      systemPrompt,
    };
  }

  /**
   * Resolve event entrypoints from CostumeConfig into CostumeEvent objects
   */
  private async resolveEvents(
    costumeName: string,
    costumeBasePath: string,
    config: CostumeConfig
  ): Promise<Costume['events']> {
    if (!config.events || config.events.length === 0) {
      return [];
    }

    const events: NonNullable<Costume['events']> = [];

    for (const eventRef of config.events) {
      const { entrypoint, guidance } = eventRef;
      const filePath = join(costumeBasePath, entrypoint.file);
      const module = await dynamicImport(filePath);

      const exportValue = module[entrypoint.export] as unknown;
      if (!isCostumeEventDef(exportValue)) {
        throw new Error(
          `Invalid event export: ${costumeName}/${entrypoint.file}:${entrypoint.export}. ` +
          `Expected CostumeEventDef but got ${typeof exportValue}`
        );
      }

      events.push({
        event: exportValue.declaration,
        guidance,
      });
    }

    return events;
  }
}

/**
 * Dynamic import with cross-platform file:// URL handling
 */
async function dynamicImport(absolutePath: string): Promise<Record<string, unknown>> {
  const moduleUrl = pathToFileURL(absolutePath).href;
  return import(moduleUrl);
}
