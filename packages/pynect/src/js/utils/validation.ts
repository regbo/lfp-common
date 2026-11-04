export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertSafeInteger(
  name: string,
  value: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
}
