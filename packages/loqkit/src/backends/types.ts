import type { LockBackendInfo } from "../types.js";

export interface PreparedBackend {
  readonly initial: Readonly<LockBackendInfo>;
  run<TResult>(
    callback: (details: Readonly<LockBackendInfo>) => Promise<TResult>,
    acquired?: readonly Readonly<LockBackendInfo>[],
  ): Promise<TResult>;
}

/** Represents an automatic layer that is unavailable and was bypassed. */
export function prepareSkippedBackend(
  details: Readonly<LockBackendInfo>,
): PreparedBackend {
  return {
    initial: details,
    async run<TResult>(
      callback: (details: Readonly<LockBackendInfo>) => Promise<TResult>,
    ): Promise<TResult> {
      return callback(details);
    },
  };
}
