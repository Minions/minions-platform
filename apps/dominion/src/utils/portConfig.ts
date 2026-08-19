import type { Directory } from '@minions/file-store';

const CONFIG_FILE = 'dominion-port.json';

export async function readDominionPort(dir: Directory): Promise<number | null> {
  const result = await dir.child(CONFIG_FILE);
  if (!result.found || result.node.kind !== 'file') {
    return null;
  }
  try {
    const config = JSON.parse(await result.node.read()) as { port?: number };
    return config.port ?? null;
  } catch {
    return null;
  }
}

export async function writeDominionPort(dir: Directory, port: number): Promise<void> {
  await dir.createFile(CONFIG_FILE, JSON.stringify({ port }, null, 2));
}
