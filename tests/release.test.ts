import { describe, expect, test } from 'bun:test';
import {
  githubRepositoryFromRemote,
  gitIdentityEmail,
  incrementVersion,
  isPublicGitHubIdentity,
  latestReleaseVersion,
  planRelease,
} from '../scripts/release-lib.ts';
import {
  computeNativeFingerprint,
  hashNativeInputs,
  nativeBuildConfig,
  nativeFingerprintPaths,
  validatePrebuildMetadata,
} from '../scripts/native-fingerprint.js';

describe('release workflow', () => {
  test('selects the greatest stable remote release tag', () => {
    const tags = [
      'a\trefs/tags/v1.9.0',
      'b\trefs/tags/not-a-release',
      'c\trefs/tags/v2.0.0-beta.1',
      'd\trefs/tags/v1.10.0',
    ].join('\n');
    expect(latestReleaseVersion(tags)).toBe('1.10.0');
  });

  test('increments stable versions', () => {
    expect(incrementVersion('1.2.3', 'patch')).toBe('1.2.4');
    expect(incrementVersion('1.2.3', 'minor')).toBe('1.3.0');
    expect(incrementVersion('1.2.3', 'major')).toBe('2.0.0');
  });

  test('plans the explicit bootstrap above the existing npm placeholder', () => {
    expect(planRelease({
      increment: 'patch',
      initial: true,
      manifestVersion: '0.2.0',
      registryLatestVersion: '0.0.0',
    })).toEqual({
      currentVersion: '0.0.0',
      initial: true,
      nextVersion: '0.2.0',
    });
    expect(() => planRelease({
      increment: 'patch',
      initial: false,
      manifestVersion: '0.2.0',
      registryLatestVersion: '0.0.0',
    })).toThrow('--initial');
  });

  test('accepts common GitHub remote forms', () => {
    for (const remote of [
      'git@github.com:regbo/pynect.git',
      'ssh://git@github.com/regbo/pynect.git',
      'https://github.com/regbo/pynect.git',
      'git+https://github.com/regbo/pynect.git',
    ]) {
      expect(githubRepositoryFromRemote(remote)).toBe('regbo/pynect');
    }
  });

  test('requires a GitHub noreply identity', () => {
    const identity = 'regbo <1002473+regbo@users.noreply.github.com> 1793548800 -0500';
    expect(gitIdentityEmail(identity)).toBe('1002473+regbo@users.noreply.github.com');
    expect(isPublicGitHubIdentity(gitIdentityEmail(identity)!)).toBe(true);
    expect(isPublicGitHubIdentity('regbo@example.com')).toBe(false);
  });

  test('fingerprints native inputs independent of enumeration order', () => {
    const first = hashNativeInputs([
      { name: 'b', content: 'second' },
      { name: 'a', content: 'first' },
    ]);
    expect(first).toBe(hashNativeInputs([
      { name: 'a', content: 'first' },
      { name: 'b', content: 'second' },
    ]));
    expect(first).not.toBe(hashNativeInputs([
      { name: 'a', content: 'changed' },
      { name: 'b', content: 'second' },
    ]));
  });

  test('fingerprints native text independent of checkout line endings', () => {
    expect(hashNativeInputs([
      { name: 'native.cpp', content: 'first\nsecond\n' },
    ])).toBe(hashNativeInputs([
      { name: 'native.cpp', content: Buffer.from('first\r\nsecond\r\n') },
    ]));
  });

  test('accepts prebuilds only for the current native fingerprint', () => {
    const fingerprint = computeNativeFingerprint();
    const target = nativeBuildConfig.targets[0]!;
    const metadata = {
      schemaVersion: 2,
      platform: target.platform,
      architecture: target.arch,
      pythonMinimumVersion: nativeBuildConfig.pythonMinimumVersion,
      pythonAbi: nativeBuildConfig.pythonAbi,
      napi: nativeBuildConfig.napi,
      nativeFingerprint: fingerprint,
      pythonLibraryName: 'libpython3.so',
    };
    expect(validatePrebuildMetadata(metadata, target, fingerprint)).toBe(true);
    expect(validatePrebuildMetadata(metadata, target, 'sha256:stale')).toBe(false);
  });

  test('excludes application configuration and generators from native inputs', () => {
    const paths = nativeFingerprintPaths();
    expect(paths).not.toContain('package.json');
    expect(paths).not.toContain('README.md');
    expect(paths.some(path => path.startsWith('src/cli/'))).toBe(false);
    expect(paths.some(path => path.startsWith('src/config/'))).toBe(false);
  });
});
