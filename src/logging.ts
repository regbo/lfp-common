let debugEnabled = false;

/** Enable or disable diagnostic logging for the current process. */
export function setDebugLogging(enabled: boolean): void {
  debugEnabled = enabled;
}

/** Write a diagnostic message to stderr when debug logging is enabled. */
export function debugLog(message: string, details?: object): void {
  if (!debugEnabled) return;
  const suffix = details ? ` ${JSON.stringify(details)}` : '';
  process.stderr.write(`[pyfig:debug] ${message}${suffix}\n`);
}