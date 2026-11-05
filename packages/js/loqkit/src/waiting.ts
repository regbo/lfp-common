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

function throwIfTimedOut(
  startedAt: number,
  timeoutMs: number | undefined,
  info: Readonly<LockInfo>,
): void {
  if (timeoutMs !== undefined && Date.now() - startedAt >= timeoutMs) {
    throw new LockTimeoutError(info, timeoutMs);
  }
}

export async function waitForRetry(
  startedAt: number,
  timeoutMs: number | undefined,
  pollIntervalMs: number,
  signal: AbortSignal | undefined,
  info: Readonly<LockInfo>,
): Promise<void> {
  throwIfAborted(signal, info);
  throwIfTimedOut(startedAt, timeoutMs, info);

  const waitMs =
    timeoutMs === undefined
      ? pollIntervalMs
      : Math.max(
          1,
          Math.min(pollIntervalMs, timeoutMs - (Date.now() - startedAt)),
        );

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
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  info: Readonly<LockInfo>,
  releaseLateAcquisition: (value: T) => void,
): Promise<T> {
  throwIfAborted(signal, info);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  const contenders: Array<Promise<T>> = [acquisition];
  if (timeoutMs !== undefined) {
    contenders.push(
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new LockTimeoutError(info, timeoutMs)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    );
  }
  if (signal) {
    contenders.push(
      new Promise<never>((_resolve, reject) => {
        abortListener = () =>
          reject(new LockAbortedError(info, signal.reason));
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    );
  }

  try {
    return await Promise.race(contenders);
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
