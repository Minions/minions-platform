import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createDiskSandbox, type Directory } from '@minions/file-store';
import type { ChromeLauncher } from './SharedBrowserService.js';

interface FindChromeOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  exists?: (p: string) => boolean;
}

/**
 * Locate a Chrome/Chromium executable. Honors an explicit `CHROME_PATH` env var,
 * then falls back to the well-known install locations for the current platform.
 * Returns null when nothing is found.
 */
export function findChromePath(opts: FindChromeOptions = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;

  const candidates: string[] = [];
  if (env.CHROME_PATH) candidates.push(env.CHROME_PATH);

  if (platform === 'win32') {
    const programFiles = env['PROGRAMFILES'] ?? 'C:\\Program Files';
    const programFilesX86 = env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
    const localAppData = env['LOCALAPPDATA'];
    candidates.push(path.win32.join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'));
    candidates.push(path.win32.join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'));
    if (localAppData) candidates.push(path.win32.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe'));
  } else if (platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    candidates.push('/usr/bin/google-chrome');
    candidates.push('/usr/bin/google-chrome-stable');
    candidates.push('/usr/bin/chromium');
    candidates.push('/usr/bin/chromium-browser');
  }

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Build the Chrome command-line args for the shared browser, matching the recipe
 * proven in the M1 spike. We force-kill Chrome between runs (no clean shutdown),
 * so `--hide-crash-restore-bubble` keeps the next launch from prompting to restore
 * the previous session's tabs.
 */
export function buildChromeArgs(opts: { port: number; userDataDir: string; headless: boolean }): string[] {
  const args = [
    `--remote-debugging-port=${opts.port}`,
    `--user-data-dir=${opts.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
  ];
  if (opts.headless) args.push('--headless=new');
  args.push('about:blank');
  return args;
}

/**
 * Mark a parsed Chrome Preferences object as cleanly exited, so Chrome will not
 * offer to restore the previous session's tabs after we force-killed it.
 */
export function applyCleanExitPrefs(prefs: Record<string, unknown>): Record<string, unknown> {
  const profile =
    prefs.profile && typeof prefs.profile === 'object'
      ? (prefs.profile as Record<string, unknown>)
      : {};
  return { ...prefs, profile: { ...profile, exit_type: 'Normal', exited_cleanly: true } };
}

/**
 * Best-effort: rewrite the profile's Preferences to record a clean exit before we
 * relaunch. Belt-and-suspenders alongside `--hide-crash-restore-bubble`. Silently
 * does nothing if the profile hasn't been created yet or can't be read/parsed.
 *
 * @param profileDir - the Chrome user-data-dir itself (i.e. the directory that
 *   contains `Default/Preferences`).
 */
async function markProfileCleanExit(profileDir: Directory): Promise<void> {
  try {
    const defaultResult = await profileDir.child('Default');
    if (!defaultResult.found || defaultResult.node.kind !== 'directory') return;

    const prefsResult = await defaultResult.node.child('Preferences');
    if (!prefsResult.found || prefsResult.node.kind !== 'file') return;

    const raw = await prefsResult.node.read();
    const prefs = JSON.parse(raw) as Record<string, unknown>;
    await prefsResult.node.write(JSON.stringify(applyCleanExitPrefs(prefs)));
  } catch {
    // No profile yet, or unreadable — the launch flag still suppresses the bubble.
  }
}

/**
 * Real {@link ChromeLauncher}: spawns a detached, keep-alive Chrome with CDP
 * enabled and a persistent profile.
 */
export function createChromeLauncher(chromePath?: string): ChromeLauncher {
  return {
    async launch(
      { port, userDataDir, headless }: { port: number; userDataDir: string; headless: boolean },
      // `dir` is rooted at userDataDir's *parent* — the same shape used
      // everywhere an injected Directory defaults off a real path — so
      // `dir.createDirectory(basename)` both creates (mkdir -p equivalent) and
      // hands back the userDataDir itself as a Directory for the rest of launch.
      dir: Directory = createDiskSandbox(path.dirname(userDataDir)).root,
    ) {
      const exe = chromePath ?? findChromePath();
      if (!exe) {
        throw new Error(
          'Could not locate a Chrome executable. Set CHROME_PATH to the Chrome/Chromium binary.',
        );
      }
      const profileDir = await dir.createDirectory(path.basename(userDataDir));
      await markProfileCleanExit(profileDir);

      // Detached + unref so the shared Chrome outlives the request and any one wing.
      const child = spawn(exe, buildChromeArgs({ port, userDataDir, headless }), {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    },
  };
}
