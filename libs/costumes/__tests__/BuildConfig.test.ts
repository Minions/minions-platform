import { describe, it, expect } from 'vitest';
import { isBuildConfig } from '../src/BuildConfig';

describe('isBuildConfig', () => {
  describe('valid configs', () => {
    it('accepts copy strategy', () => {
      expect(isBuildConfig({ strategy: 'copy' })).toBe(true);
    });

    it('accepts bundle strategy', () => {
      expect(isBuildConfig({ strategy: 'bundle' })).toBe(true);
    });

    it('accepts bundle strategy with bundleDirs', () => {
      expect(isBuildConfig({
        strategy: 'bundle',
        bundle: { bundleDirs: ['missions', 'events'] },
      })).toBe(true);
    });

    it('accepts bundle strategy with external', () => {
      expect(isBuildConfig({
        strategy: 'bundle',
        bundle: { external: ['@modelcontextprotocol/*'] },
      })).toBe(true);
    });

    it('accepts bundle strategy with all options', () => {
      expect(isBuildConfig({
        strategy: 'bundle',
        bundle: {
          bundleDirs: ['missions'],
          external: ['@modelcontextprotocol/*'],
        },
      })).toBe(true);
    });

    it('accepts bundle strategy with empty bundle config', () => {
      expect(isBuildConfig({
        strategy: 'bundle',
        bundle: {},
      })).toBe(true);
    });
  });

  describe('invalid configs', () => {
    it('rejects null', () => {
      expect(isBuildConfig(null)).toBe(false);
    });

    it('rejects non-object', () => {
      expect(isBuildConfig('copy')).toBe(false);
    });

    it('rejects missing strategy', () => {
      expect(isBuildConfig({})).toBe(false);
    });

    it('rejects unknown strategy', () => {
      expect(isBuildConfig({ strategy: 'minify' })).toBe(false);
    });

    it('rejects non-string strategy', () => {
      expect(isBuildConfig({ strategy: 42 })).toBe(false);
    });

    it('rejects non-object bundle', () => {
      expect(isBuildConfig({ strategy: 'bundle', bundle: 'bad' })).toBe(false);
    });

    it('rejects non-array bundleDirs', () => {
      expect(isBuildConfig({
        strategy: 'bundle',
        bundle: { bundleDirs: 'missions' },
      })).toBe(false);
    });

    it('rejects non-string items in bundleDirs', () => {
      expect(isBuildConfig({
        strategy: 'bundle',
        bundle: { bundleDirs: [42] },
      })).toBe(false);
    });

    it('rejects non-array external', () => {
      expect(isBuildConfig({
        strategy: 'bundle',
        bundle: { external: '@modelcontextprotocol/*' },
      })).toBe(false);
    });

    it('rejects non-string items in external', () => {
      expect(isBuildConfig({
        strategy: 'bundle',
        bundle: { external: [42] },
      })).toBe(false);
    });
  });
});
