import { describe, it, expect } from 'vitest';
import { parseLairConfig, readLairConfig } from './parser.js';

const PRIMARY_URL = 'https://github.com/acme/suite.git';

describe('parseLairConfig', () => {
  it('parses a full config with all fields', () => {
    const content = `---
lair_name: "Acme Suite"
planning:
  repo: https://github.com/acme/planning.git
  branch: develop
  path: plans/
work_archives:
  - name: local
    url: https://github.com/acme/suite.git
info_archives:
  - name: minions
    url: https://github.com/CodeWarp/suite.git
---

# Post-Install Mission

Welcome! Please review the project structure.
`;

    const config = parseLairConfig(content, PRIMARY_URL);

    expect(config.lairName).toBe('Acme Suite');
    expect(config.planning.repo).toBe('https://github.com/acme/planning.git');
    expect(config.planning.branch).toBe('develop');
    expect(config.planning.path).toBe('plans/');
    expect(config.workArchives).toEqual([{ name: 'local', url: 'https://github.com/acme/suite.git' }]);
    expect(config.infoArchives).toEqual([{ name: 'minions', url: 'https://github.com/CodeWarp/suite.git' }]);
    expect(config.postInstallMission).toContain('Welcome!');
  });

  it('applies defaults when only front-matter delimiters are present', () => {
    const content = `---
---
`;
    const config = parseLairConfig(content, PRIMARY_URL);

    expect(config.lairName).toBe('suite'); // inferred from URL
    expect(config.planning.repo).toBe(PRIMARY_URL);
    expect(config.planning.branch).toBe('main');
    expect(config.planning.path).toBe('plans/');
    expect(config.workArchives).toEqual([{ name: 'local', url: PRIMARY_URL }]);
    expect(config.infoArchives).toEqual([]);
    expect(config.postInstallMission).toBeNull();
  });

  it('applies defaults when there is no front-matter', () => {
    const content = `Just some markdown without front-matter.`;
    const config = parseLairConfig(content, PRIMARY_URL);

    expect(config.lairName).toBe('suite');
    expect(config.planning.repo).toBe(PRIMARY_URL);
    expect(config.workArchives).toEqual([{ name: 'local', url: PRIMARY_URL }]);
    expect(config.postInstallMission).toContain('markdown'); // body becomes mission
  });

  it('extracts post-install mission body', () => {
    const content = `---
lair_name: Test
---
Welcome to your lair!

This is a multi-line mission.
`;
    const config = parseLairConfig(content, PRIMARY_URL);
    expect(config.postInstallMission).toBe('Welcome to your lair!\n\nThis is a multi-line mission.');
  });
});

describe('readLairConfig', () => {
  it('returns found=false with defaults when file is missing', async () => {
    const readFile = async (_path: string) => null;
    const result = await readLairConfig(readFile, PRIMARY_URL);

    expect(result.found).toBe(false);
    expect(result.config.lairName).toBe('suite');
  });

  it('returns found=true with parsed config when file exists', async () => {
    const fileContent = `---
lair_name: "My Lair"
---
Hello!
`;
    const readFile = async (path: string) =>
      path === '.minions-lair.config.md' ? fileContent : null;
    const result = await readLairConfig(readFile, PRIMARY_URL);

    expect(result.found).toBe(true);
    expect(result.config.lairName).toBe('My Lair');
    expect(result.config.postInstallMission).toBe('Hello!');
  });
});
