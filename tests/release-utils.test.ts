import { describe, expect, test } from 'bun:test';
import {
  assertAutoCommitCompatible,
  isPrivateGitHubEmail,
  isPyfigGitHubRemote,
  latestRemoteVersion,
  nextReleaseVersion,
} from '../scripts/release-utils.ts';

describe('release utilities', () => {
  test('selects the greatest valid GitHub SemVer tag', () => {
    const output = [
      '1111111\trefs/tags/not-a-version',
      '2222222\trefs/tags/v1.9.0',
      '3333333\trefs/tags/v2.0.0-beta.1',
      '4444444\trefs/tags/v1.10.0',
    ].join('\n');
    expect(latestRemoteVersion(output)).toBe('2.0.0-beta.1');
    expect(nextReleaseVersion('2.0.0-beta.1', 'patch')).toBe('2.0.0');
  });

  test('accepts only the expected GitHub remote forms', () => {
    expect(isPyfigGitHubRemote('git@github.com:regbo/pyfig.git')).toBe(true);
    expect(isPyfigGitHubRemote('https://github.com/regbo/pyfig')).toBe(true);
    expect(isPyfigGitHubRemote('https://example.com/regbo/pyfig')).toBe(false);
  });

  test('requires a GitHub noreply release identity', () => {
    expect(isPrivateGitHubEmail('1002473+regbo@users.noreply.github.com')).toBe(true);
    expect(isPrivateGitHubEmail('regbo@example.com')).toBe(false);
  });

  test('accepts ordinary source changes for automatic commits', () => {
    expect(assertAutoCommitCompatible(' M src/cli.ts\n?? docs/release.md')).toEqual([
      { path: 'src/cli.ts', status: ' M' },
      { path: 'docs/release.md', status: '??' },
    ]);
  });

  test('rejects conflicts while allowing ordinary metadata edits', () => {
    expect(() => assertAutoCommitCompatible('UU src/cli.ts')).toThrow('merge conflicts');
    expect(assertAutoCommitCompatible(' M package.json\n M bun.lock')).toHaveLength(2);
    expect(assertAutoCommitCompatible(' D old.ts\nA  new.ts')).toHaveLength(2);
  });
});
