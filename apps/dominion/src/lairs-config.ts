import type { Directory } from '@minions/file-store';

export interface LairEntry {
  name: string;
  root: string;
  port: number;
}

export interface LairsConfig {
  lairs: LairEntry[];
}

export async function readLairsConfig(dir: Directory): Promise<LairsConfig> {
  const result = await dir.child('lairs.json');
  if (!result.found || result.node.kind !== 'file') {
    return { lairs: [] };
  }
  try {
    return JSON.parse(await result.node.read()) as LairsConfig;
  } catch {
    return { lairs: [] };
  }
}

export async function writeLairsConfig(dir: Directory, config: LairsConfig): Promise<void> {
  await dir.createFile('lairs.json', JSON.stringify(config, null, 2));
}

export async function addLair(dir: Directory, entry: LairEntry): Promise<void> {
  const config = await readLairsConfig(dir);
  const existing = config.lairs.findIndex(l => l.root === entry.root);
  if (existing >= 0) {
    config.lairs[existing] = entry;
  } else {
    config.lairs.push(entry);
  }
  await writeLairsConfig(dir, config);
}
