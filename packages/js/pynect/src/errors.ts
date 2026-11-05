/** Normalize thrown values at process and stream boundaries. */
export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
