import type { LockInfo } from "./types.js";

abstract class LoqkitError extends Error {
  abstract readonly code: string;

  constructor(
    message: string,
    readonly lock: Readonly<LockInfo>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class LockTimeoutError extends LoqkitError {
  readonly code = "LOQKIT_TIMEOUT";

  constructor(lock: Readonly<LockInfo>, timeoutMs: number) {
    super(
      `Timed out after ${timeoutMs}ms waiting for lock "${lock.name}"`,
      lock,
    );
  }
}

export class LockAbortedError extends LoqkitError {
  readonly code = "LOQKIT_ABORTED";

  constructor(lock: Readonly<LockInfo>, cause?: unknown) {
    super(`Waiting for lock "${lock.name}" was aborted`, lock, { cause });
  }
}

export class LockUnavailableError extends LoqkitError {
  readonly code = "LOQKIT_UNAVAILABLE";

  constructor(lock: Readonly<LockInfo>, detail: string, cause?: unknown) {
    super(`Lock "${lock.name}" is unavailable: ${detail}`, lock, { cause });
  }
}
