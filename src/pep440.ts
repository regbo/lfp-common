import {
  filter,
  maxSatisfying,
  valid as validPep440Version,
  validRange as validPep440Specifier,
} from '@renovatebot/pep440';

/** Validate a PEP 440 version specifier used by a runtime policy. */
export function isValidPep440Specifier(specifier: string): boolean {
  return validPep440Specifier(specifier);
}

/** Normalize a PEP 440 version, or reject invalid input. */
export function normalizePep440Version(version: string): string | null {
  return validPep440Version(version);
}

/**
 * Match a version using PEP 440 specifier-set behavior, including its
 * pre-release fallback when the candidate set has no matching final release.
 */
export function pep440VersionSatisfies(version: string, specifier: string): boolean {
  return filter([version], specifier).length === 1;
}

/** Select the greatest PEP 440 version allowed by a specifier. */
export function maxPep440Version(
  versions: readonly string[],
  specifier: string,
): string | null {
  return maxSatisfying([...versions], specifier);
}
