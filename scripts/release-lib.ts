import semver from 'semver';

export type ReleaseIncrement = 'major' | 'minor' | 'patch';

export interface ReleasePlan {
  readonly currentVersion?: string;
  readonly initial: boolean;
  readonly nextVersion: string;
}
/** Select the greatest stable v<SemVer> tag from git ls-remote output. */
export function latestReleaseVersion(output: string): string | undefined {
  const versions = output
    .split(/\r?\n/u)
    .map(line => /refs\/tags\/v([^\s]+)$/u.exec(line)?.[1])
    .filter((value): value is string => Boolean(value && semver.valid(value)));
  return semver.rsort(versions)[0];
}

export function incrementVersion(value: string, increment: ReleaseIncrement): string {
  const next = semver.inc(value, increment);
  if (!next) throw new Error(`Invalid stable SemVer: ${value}.`);
  return next;
}

export function planRelease(options: {
  readonly increment: ReleaseIncrement;
  readonly initial: boolean;
  readonly latestRemoteVersion?: string;
  readonly manifestVersion: string;
}): ReleasePlan {
  if (!semver.valid(options.manifestVersion)) {
    throw new Error(`package.json has invalid stable SemVer: ${options.manifestVersion}.`);
  }
  if (semver.prerelease(options.manifestVersion)) {
    throw new Error(`Shared releases must use stable SemVer: ${options.manifestVersion}.`);
  }

  if (options.latestRemoteVersion) {
    if (options.initial) throw new Error('--initial is only valid when the remote has no release tags.');
    if (options.manifestVersion !== options.latestRemoteVersion) {
      throw new Error(
        `Shared version ${options.manifestVersion} must match latest remote tag v${options.latestRemoteVersion}.`,
      );
    }
    return {
      currentVersion: options.latestRemoteVersion,
      initial: false,
      nextVersion: incrementVersion(options.latestRemoteVersion, options.increment),
    };
  }

  if (!options.initial) {
    throw new Error(
      'The remote has no release tags; rerun with --initial after confirming the configured version.',
    );
  }
  return {
    initial: true,
    nextVersion: options.manifestVersion,
  };
}

export function githubRepositoryFromRemote(remote: string): string | undefined {
  return /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|(?:git\+)?https:\/\/github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/iu
    .exec(remote.trim())?.[1];
}

export function gitIdentityEmail(identity: string): string | undefined {
  return /<([^<>]+)>\s+\d+\s+[+-]\d{4}$/u.exec(identity.trim())?.[1];
}

export function isPublicGitHubIdentity(email: string): boolean {
  return /^(?:\d+\+)?[^@\s]+@users\.noreply\.github\.com$/iu.test(email);
}

export function registryVersionUrl(name: string, version: string): string {
  return `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
}
