import type { LockBackendInfo } from "../types.js";

export interface PreparedBackend {
  readonly initial: Readonly<LockBackendInfo>;
  run<TResult>(
    callback: (details: Readonly<LockBackendInfo>) => Promise<TResult>,
  ): Promise<TResult>;
}
