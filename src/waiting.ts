import { setTimeout as delay } from "node:timers/promises";
import { LockAbortedError, LockTimeoutError } from "./errors.js";
import type { LockInfo } from "./types.js";

export function throwIfAborted(
  signal: AbortSignal | undefined,
  info: Readonly<LockInfo>,
): void {
  if (signal?.aborted) {
    throw new LockAbortedError(info, signal.reason);
  }
}

export function throwIfTimedOut(
  startedAt: number,
  timeoutMs: number,
  info: Readonly<LockInfo>,
): void {
  if (Date.now() - startedAt >= timeoutMs) {
    throw new LockTimeoutError(info, timeoutMs);
  }
}

export async function waitForRetry(
  startedAt: number,
  timeoutMs: number,
  pollIntervalMs: number,
  signal: AbortSignal | undefined,
  info: Readonly<LockInfo>,
): Promise<void> {
  throwIfAborted(signal, info);
  throwIfTimedOut(startedAt, timeoutMs, info);

  const remaining = timeoutMs - (Date.now() - startedAt);
  const waitMs = Math.max(1, Math.min(pollIntervalMs, remaining));

  try {
    await delay(waitMs, undefined, { signal });
  } catch (error) {
    if (signal?.aborted) {
      throw new LockAbortedError(info, signal.reason);
    }
    throw error;
  }
}

export async function acquireWithLimits<T>(
  acquisition: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  info: Readonly<LockInfo>,
  releaseLateAcquisition: (value: T) => void,
): Promise<T> {
  throwIfAborted(signal, info);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new LockTimeoutError(info, timeoutMs)),
      timeoutMs,
    );
    timer.unref?.();

    if (signal) {
      abortListener = () => reject(new LockAbortedError(info, signal.reason));
      signal.addEventListener("abort", abortListener, { once: true });
    }
  });

  try {
    return await Promise.race([acquisition, limit]);
  } catch (error) {
    void acquisition.then(releaseLateAcquisition, () => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}
