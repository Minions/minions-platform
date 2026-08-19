import { describe, it, expect } from 'vitest';
import { interpretVersion, browserIdFromWsUrl } from './chromeProbe.js';
import { findChromePath, buildChromeArgs, applyCleanExitPrefs } from './chromeLauncher.js';
import { createCabinetConfigStore, sharedBrowserProfileDir } from './config.js';
import { createInMemorySandbox, type File } from '@minions/file-store';

describe('browserIdFromWsUrl', () => {
  it('extracts the browser GUID from a webSocketDebuggerUrl', () => {
    expect(browserIdFromWsUrl('ws://127.0.0.1:9333/devtools/browser/abc-123')).toBe('abc-123');
  });

  it('falls back to the whole string when the shape is unexpected', () => {
    expect(browserIdFromWsUrl('weird')).toBe('weird');
  });
});

describe('interpretVersion', () => {
  it('classifies a valid CDP /json/version response as Chrome and carries its identity', () => {
    const result = interpretVersion(true, {
      Browser: 'Chrome/149.0.7827.116',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/the-guid',
    });
    expect(result).toEqual({ status: 'chrome', browserId: 'the-guid' });
  });

  it('classifies a non-OK HTTP response as a foreign occupant', () => {
    expect(interpretVersion(false, null)).toEqual({ status: 'foreign' });
  });

  it('classifies an OK response that is not CDP JSON as a foreign occupant', () => {
    expect(interpretVersion(true, { hello: 'world' })).toEqual({ status: 'foreign' });
    expect(interpretVersion(true, 'not json')).toEqual({ status: 'foreign' });
  });
});

describe('findChromePath', () => {
  it('honors an explicit CHROME_PATH when the binary exists', () => {
    const found = findChromePath({
      platform: 'linux',
      env: { CHROME_PATH: '/custom/chrome' },
      exists: (p) => p === '/custom/chrome',
    });
    expect(found).toBe('/custom/chrome');
  });

  it('falls back to a known Windows install location', () => {
    const winPath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const found = findChromePath({
      platform: 'win32',
      env: {},
      exists: (p) => p === winPath,
    });
    expect(found).toBe(winPath);
  });

  it('finds Chrome on macOS at its standard app bundle path', () => {
    const macPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const found = findChromePath({
      platform: 'darwin',
      env: {},
      exists: (p) => p === macPath,
    });
    expect(found).toBe(macPath);
  });

  it('returns null when no candidate exists', () => {
    const found = findChromePath({ platform: 'linux', env: {}, exists: () => false });
    expect(found).toBeNull();
  });
});

describe('buildChromeArgs', () => {
  it('sets the CDP port, persistent profile, and startup-noise suppressors', () => {
    const args = buildChromeArgs({ port: 9333, userDataDir: '/p', headless: false });
    expect(args).toContain('--remote-debugging-port=9333');
    expect(args).toContain('--user-data-dir=/p');
    expect(args).toContain('--no-first-run');
    expect(args).toContain('--no-default-browser-check');
    // We force-kill Chrome between runs, so suppress the "restore pages?" bubble.
    expect(args).toContain('--hide-crash-restore-bubble');
  });

  it('adds the headless flag only when headless is requested', () => {
    expect(buildChromeArgs({ port: 1, userDataDir: '/p', headless: true })).toContain('--headless=new');
    expect(buildChromeArgs({ port: 1, userDataDir: '/p', headless: false })).not.toContain('--headless=new');
  });
});

describe('applyCleanExitPrefs', () => {
  it('marks the profile as cleanly exited so Chrome will not offer to restore', () => {
    const out = applyCleanExitPrefs({}) as { profile: { exit_type: string; exited_cleanly: boolean } };
    expect(out.profile.exit_type).toBe('Normal');
    expect(out.profile.exited_cleanly).toBe(true);
  });

  it('preserves other preferences and profile fields', () => {
    const out = applyCleanExitPrefs({
      profile: { name: 'me', exit_type: 'Crashed', exited_cleanly: false },
      other: 1,
    }) as { profile: { name: string; exit_type: string }; other: number };
    expect(out.profile.name).toBe('me');
    expect(out.profile.exit_type).toBe('Normal');
    expect(out.other).toBe(1);
  });
});

describe('sharedBrowserProfileDir', () => {
  it('places the profile under the lair root', () => {
    const dir = sharedBrowserProfileDir('/lair');
    expect(dir).toContain('lair');
    expect(dir).toContain('.shared-browser');
  });
});

describe('createCabinetConfigStore', () => {
  it('returns null when no shared-browser state has been persisted', async () => {
    const sandbox = createInMemorySandbox();
    const store = createCabinetConfigStore(sandbox.root, 3000);

    expect(await store.get()).toBeNull();
  });

  it('round-trips shared-browser state through cabinet.config.json', async () => {
    const sandbox = createInMemorySandbox();
    const store = createCabinetConfigStore(sandbox.root, 3000);

    await store.set({ port: 9335, browserId: 'gid-xyz' });

    expect(await store.get()).toEqual({ port: 9335, browserId: 'gid-xyz' });
  });

  it('preserves other cabinet.config.json fields when writing state', async () => {
    const sandbox = createInMemorySandbox();
    await sandbox.root.createFile(
      'cabinet.config.json',
      JSON.stringify({ port: 4321, defaultRegistry: 'official' }, null, 2),
    );
    const store = createCabinetConfigStore(sandbox.root, 3000);

    await store.set({ port: 9336, browserId: 'gid-keep' });

    const result = await sandbox.root.child('cabinet.config.json');
    if (!result.found || !result.node.is('file')) throw new Error('config file missing');
    const raw = JSON.parse(await (result.node as File).read());
    expect(raw.port).toBe(4321);
    expect(raw.defaultRegistry).toBe('official');
    expect(raw.sharedBrowser).toEqual({ port: 9336, browserId: 'gid-keep' });
  });
});
