import semver from 'semver';

export const RELEASE_INCREMENTS = ['major', 'minor', 'patch'] as const;
export type ReleaseIncrement = typeof RELEASE_INCREMENTS[number];

/** Select the greatest valid SemVer tag from `git ls-remote --tags --refs`. */
export function latestRemoteVersion(output: string): string {
  const versions = output
    .split(/\r?\n/u)
    .map(line => line.match(/\srefs\/tags\/v([^\s]+)$/u)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(value => semver.valid(value))
    .filter((value): value is string => value !== null);
  const latest = semver.rsort(versions)[0];
  if (!latest) throw new Error('The GitHub remote has no valid v<SemVer> release tags.');
  return latest;
}

export function nextReleaseVersion(version: string, increment: ReleaseIncrement): string {
  const next = semver.inc(version, increment);
  if (!next) throw new Error(`Could not apply ${increment} to ${version}.`);
  return next;
}

export function isPyfigGitHubRemote(value: string): boolean {
  return /^(?:git@github\.com:|https:\/\/github\.com\/)regbo\/pyfig(?:\.git)?\/?$/iu.test(value);
}

export function isPrivateGitHubEmail(value: string): boolean {
  return /^(?:\d+\+)?[^@\s]+@users\.noreply\.github\.com$/iu.test(value);
}
