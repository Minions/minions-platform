import type { Directory, File } from '@minions/file-store';
import type { CabinetConfig } from '../registry/types.js';

export type { CabinetConfig };

const CONFIG_FILE = 'cabinet.config.json';

/**
 * Read the cabinet port from the config file.
 * Returns null if the config file does not exist or is invalid.
 */
export async function readCabinetPort(lairDir: Directory): Promise<number | null> {
  const result = await lairDir.child(CONFIG_FILE);
  if (!result.found || !result.node.is('file')) {
    return null;
  }
  try {
    const content = await (result.node as File).read();
    const config: CabinetConfig = JSON.parse(content);
    if (typeof config.port === 'number') {
      return config.port;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write the cabinet port to the config file.
 */
export async function writeCabinetPort(lairDir: Directory, port: number): Promise<void> {
  const existing = await readCabinetConfig(lairDir);
  const config: CabinetConfig = { ...existing, port };
  const content = JSON.stringify(config, null, 2);

  const result = await lairDir.child(CONFIG_FILE);
  if (result.found && result.node.is('file')) {
    await (result.node as File).write(content);
  } else {
    await lairDir.createFile(CONFIG_FILE, content);
  }
}

/**
 * Read the full cabinet config from the config file.
 * Returns null if the config file does not exist or is invalid.
 */
export async function readCabinetConfig(lairDir: Directory): Promise<CabinetConfig | null> {
  const result = await lairDir.child(CONFIG_FILE);
  if (!result.found || !result.node.is('file')) {
    return null;
  }
  try {
    const content = await (result.node as File).read();
    const config = JSON.parse(content) as CabinetConfig;
    if (typeof config.port === 'number') {
      return config;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write the full cabinet config to the config file, preserving existing fields.
 */
export async function writeCabinetConfig(lairDir: Directory, config: CabinetConfig): Promise<void> {
  const content = JSON.stringify(config, null, 2);
  const result = await lairDir.child(CONFIG_FILE);
  if (result.found && result.node.is('file')) {
    await (result.node as File).write(content);
  } else {
    await lairDir.createFile(CONFIG_FILE, content);
  }
}
