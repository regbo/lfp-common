export type DebugLogger = (message: string, details?: object) => void;

/** Create a context-local diagnostic logger without mutable process-wide state. */
export function createDebugLogger(enabled: boolean): DebugLogger {
  if (!enabled) return () => {};
  return (message, details) => {
    const suffix = details ? ` ${JSON.stringify(details)}` : '';
    process.stderr.write(`[pyfig:debug] ${message}${suffix}\n`);
  };
}
