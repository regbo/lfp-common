export type ReleaseIncrement = 'major' | 'minor' | 'patch';

interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export interface ReleasePlan {
  readonly currentVersion: string | undefined;
  readonly initial: boolean;
  readonly nextVersion: string;
}

export interface NpmPackResult {
  readonly filename?: string;
}

/** Normalize the npm 11 array and npm 12 package-keyed `npm pack --json` formats. */
export function npmPackResults(value: unknown): NpmPackResult[] {
  if (Array.isArray(value)) return value as NpmPackResult[];
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, NpmPackResult>);
  }
  return [];
}

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function parseVersion(value: string): SemVer | undefined {
  const match = versionPattern.exec(value);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function incrementVersion(value: string, increment: ReleaseIncrement): string {
  const version = parseVersion(value);
  if (!version) throw new Error(`Invalid stable SemVer: ${value}`);
  if (increment === 'major') return `${version.major + 1}.0.0`;
  if (increment === 'minor') return `${version.major}.${version.minor + 1}.0`;
  return `${version.major}.${version.minor}.${version.patch + 1}`;
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error(`Cannot compare invalid SemVer: ${left}, ${right}`);
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** Select the greatest stable v<SemVer> tag from git ls-remote output. */
export function latestReleaseVersion(output: string): string | undefined {
  return output
    .split(/\r?\n/u)
    .map(line => /refs\/tags\/v([^\s]+)$/u.exec(line)?.[1])
    .filter((value): value is string => Boolean(value && parseVersion(value)))
    .sort(compareVersions)
    .at(-1);
}

export function planRelease(options: {
  readonly increment: ReleaseIncrement;
  readonly initial: boolean;
  readonly latestRemoteVersion?: string;
  readonly manifestVersion: string;
  readonly registryLatestVersion?: string;
}): ReleasePlan {
  if (!parseVersion(options.manifestVersion)) {
    throw new Error(`package.json has invalid stable SemVer: ${options.manifestVersion}`);
  }
  if (options.latestRemoteVersion) {
    if (options.initial) throw new Error('--initial is only valid without remote release tags');
    if (options.manifestVersion !== options.latestRemoteVersion) {
      throw new Error(
        `package.json version ${options.manifestVersion} does not match latest remote tag v${options.latestRemoteVersion}`,
      );
    }
    return {
      currentVersion: options.latestRemoteVersion,
      initial: false,
      nextVersion: incrementVersion(options.latestRemoteVersion, options.increment),
    };
  }
  if (!options.initial) {
    throw new Error('The remote has no release tags; rerun with --initial after confirming bootstrap');
  }
  if (options.registryLatestVersion) {
    if (options.manifestVersion !== options.registryLatestVersion) {
      throw new Error(
        `package.json version ${options.manifestVersion} does not match npm latest ${options.registryLatestVersion}`,
      );
    }
    return {
      currentVersion: options.registryLatestVersion,
      initial: true,
      nextVersion: incrementVersion(options.registryLatestVersion, options.increment),
    };
  }
  return { currentVersion: undefined, initial: true, nextVersion: options.manifestVersion };
}

export function githubRepositoryFromRemote(remote: string): string | undefined {
  return /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|(?:git\+)?https:\/\/github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/iu
    .exec(remote.trim())?.[1];
}

export function gitIdentityEmail(identity: string): string | undefined {
  return /<([^<>]+)>\s+\d+\s+[+-]\d{4}$/u.exec(identity.trim())?.[1];
}

export function isPublicGitHubIdentity(email: string): boolean {
  return /^(?:\d+\+)?[^@]+@users\.noreply\.github\.com$/iu.test(email);
}

export function registryVersionUrl(name: string, version: string): string {
  return `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
}

export function registryPackageUrl(name: string): string {
  return `https://registry.npmjs.org/${encodeURIComponent(name)}`;
}
