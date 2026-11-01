import {
  filter,
  valid as validPep440Version,
  validRange as validPep440Specifier,
} from '@renovatebot/pep440';

/** Validate the PEP 440 syntax used by pyproject.toml's requires-python field. */
export function isValidPythonSpecifier(specifier: string): boolean {
  return validPep440Specifier(specifier);
}

/** Validate one normalized Python interpreter version. */
export function isValidPythonVersion(version: string): boolean {
  return validPep440Version(version) !== null;
}

/**
 * Match a Python version using PEP 440's specifier-set behavior, including its
 * pre-release fallback when the candidate set has no matching final release.
 */
export function pythonVersionSatisfies(version: string, specifier: string): boolean {
  return filter([version], specifier).length === 1;
}
