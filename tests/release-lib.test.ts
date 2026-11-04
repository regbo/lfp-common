import { describe, expect, test } from 'bun:test';
import {
  githubRepositoryFromRemote,
  incrementVersion,
  isPublicGitHubIdentity,
  latestReleaseVersion,
  planRelease,
} from '../scripts/release-lib.ts';

describe('release version planning', () => {
  test('selects the greatest valid remote tag', () => {
    expect(latestReleaseVersion([
      'aaa\trefs/tags/v0.8.2',
      'bbb\trefs/tags/not-a-release',
      'ccc\trefs/tags/v0.10.0',
      'ddd\trefs/tags/v0.9.7',
    ].join('\n'))).toBe('0.10.0');
  });

  test('increments stable versions', () => {
    expect(incrementVersion('1.2.3', 'patch')).toBe('1.2.4');
    expect(incrementVersion('1.2.3', 'minor')).toBe('1.3.0');
    expect(incrementVersion('1.2.3', 'major')).toBe('2.0.0');
  });

  test('keeps the configured version for an explicit initial release', () => {
    expect(planRelease({
      increment: 'patch',
      initial: true,
      manifestVersion: '0.8.0',
    })).toEqual({ initial: true, nextVersion: '0.8.0' });
  });
});
describe('public GitHub repository and identity checks', () => {
  test('accepts supported remote forms', () => {
    expect(githubRepositoryFromRemote('git@github.com:regbo/lfp-common.git')).toBe('regbo/lfp-common');
    expect(githubRepositoryFromRemote('https://github.com/regbo/lfp-common.git')).toBe('regbo/lfp-common');
    expect(githubRepositoryFromRemote('ssh://git@github.com/regbo/lfp-common.git')).toBe('regbo/lfp-common');
  });

  test('requires a GitHub noreply identity', () => {
    expect(isPublicGitHubIdentity('123+regbo@users.noreply.github.com')).toBeTrue();
    expect(isPublicGitHubIdentity('personal@example.com')).toBeFalse();
  });
});
