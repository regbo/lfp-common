import semver from 'semver';

export const RELEASE_INCREMENTS = ['major', 'minor', 'patch'] as const;
export type ReleaseIncrement = typeof RELEASE_INCREMENTS[number];

interface GitStatusEntry {
  readonly path: string;
  readonly status: string;
}

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

/** Parse ordinary entries from `git status --porcelain=v1`. */
export function parseGitStatus(output: string): GitStatusEntry[] {
  return output
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(line => {
      if (line.length < 4) throw new Error(`Could not parse git status entry: ${line}`);
      const status = line.slice(0, 2);
      const rawPath = line.slice(3);
      const path = rawPath.includes(' -> ') ? rawPath.split(' -> ').at(-1) ?? '' : rawPath;
      return { path: unquoteGitPath(path), status };
    });
}

/** Reject files that should never be included in an automatic release-preparation commit. */
export function assertAutoCommitCompatible(output: string): GitStatusEntry[] {
  const entries = parseGitStatus(output);
  const conflicts = entries.filter(entry =>
    ['AA', 'AU', 'DD', 'DU', 'UA', 'UD', 'UU'].includes(entry.status)
  );
  if (conflicts.length > 0) {
    throw new Error(`Cannot auto-commit unresolved merge conflicts: ${formatPaths(conflicts)}.`);
  }
  return entries;
}

function formatPaths(entries: readonly GitStatusEntry[]): string {
  return entries.map(entry => entry.path).join(', ');
}

function unquoteGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value;
  }
}
