import { describe, expect, test } from 'bun:test';
import {
  githubRepositoryFromRemote,
  isPublicGitHubIdentity,
  latestReleaseVersion,
  npmPackResults,
  planRelease,
} from '../scripts/release-lib.ts';

describe('release planning', () => {
  test('selects the greatest remote version and increments it', () => {
    const tags = [
      'a refs/tags/v0.9.0',
      'b refs/tags/v0.10.0',
      'c refs/tags/not-semver',
    ].join('\n');
    expect(latestReleaseVersion(tags)).toBe('0.10.0');
    expect(planRelease({
      increment: 'patch',
      initial: false,
      latestRemoteVersion: '0.10.0',
      manifestVersion: '0.10.0',
    }).nextVersion).toBe('0.10.1');
  });

  test('requires explicit bootstrap when npm exists without tags', () => {
    expect(() => planRelease({
      increment: 'patch',
      initial: false,
      manifestVersion: '0.0.1',
      registryLatestVersion: '0.0.1',
    })).toThrow('--initial');
    expect(planRelease({
      increment: 'patch',
      initial: true,
      manifestVersion: '0.0.1',
      registryLatestVersion: '0.0.1',
    }).nextVersion).toBe('0.0.2');
  });

  test('accepts common GitHub remotes and private identities', () => {
    expect(githubRepositoryFromRemote('git@github.com:regbo/optionkit.git')).toBe('regbo/optionkit');
    expect(githubRepositoryFromRemote('https://github.com/regbo/optionkit')).toBe('regbo/optionkit');
    expect(isPublicGitHubIdentity('123+user@users.noreply.github.com')).toBeTrue();
    expect(isPublicGitHubIdentity('user@example.com')).toBeFalse();
  });

  test('normalizes npm 11 and npm 12 pack output', () => {
    const result = { filename: 'optionkit-0.0.2.tgz' };
    expect(npmPackResults([result])).toEqual([result]);
    expect(npmPackResults({ optionkit: result })).toEqual([result]);
    expect(npmPackResults(undefined)).toEqual([]);
  });
});
