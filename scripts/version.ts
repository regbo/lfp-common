import { readFileSync } from 'node:fs';
import path from 'node:path';
import semver from 'semver';

export const VERSION_FILE = 'VERSION';

/** Read and validate the repository's authoritative stable version. */
export function readRootVersion(root: string): string {
  const version = readFileSync(path.join(root, VERSION_FILE), 'utf8').trim();
  if (!semver.valid(version) || semver.prerelease(version)) {
    throw new Error(`${VERSION_FILE} must contain one stable semantic version, found ${version || '<empty>'}.`);
  }
  return version;
}
