import * as workerThreads from "node:worker_threads";
import {
  LockAbortedError,
  LockTimeoutError,
  LockUnavailableError,
} from "../errors.js";
import type { ResolvedLockOptionsData } from "../schemas.js";
import type { LockBackendInfo, LockInfo } from "../types.js";
import type { PreparedBackend } from "./types.js";

interface WorkerLockManager {
  request<TResult>(
    name: string,
    options: {
      mode: "exclusive";
      ifAvailable?: boolean;
      signal?: AbortSignal;
    },
    callback: (lock: object | null) => TResult | PromiseLike<TResult>,
  ): Promise<TResult>;
}

function getWorkerLocks(): WorkerLockManager | undefined {
  const candidate = (workerThreads as unknown as { locks?: WorkerLockManager })
    .locks;
  return candidate && typeof candidate.request === "function"
    ? candidate
    : undefined;
}

function passThroughBackend(
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

export function prepareWorkerBackend(
  info: Readonly<LockInfo>,
  options: ResolvedLockOptionsData,
  memoryAlreadyHeld = false,
): PreparedBackend {
  const locks = getWorkerLocks();
  if (!locks) {
    const fallback = {
      scope: "worker",
      type: "memory",
      fallback: "worker-locks-unavailable",
    } as const satisfies LockBackendInfo;
    if (memoryAlreadyHeld) return passThroughBackend(fallback);
    throw new LockUnavailableError(
      info,
      "the runtime does not provide worker_threads.locks",
    );
  }

  const details = {
    scope: "worker",
    type: "worker",
  } as const satisfies LockBackendInfo;

  return {
    initial: details,
    async run<TResult>(
      callback: (details: Readonly<LockBackendInfo>) => Promise<TResult>,
    ): Promise<TResult> {
      const controller = new AbortController();
      let acquired = false;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const abortFromCaller = () => controller.abort(options.signal?.reason);
      if (options.signal?.aborted) {
        throw new LockAbortedError(info, options.signal.reason);
      }
      options.signal?.addEventListener("abort", abortFromCaller, { once: true });

      const stopWaiting = () => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        options.signal?.removeEventListener("abort", abortFromCaller);
      };

      if (options.timeout && options.timeout.ms > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, options.timeout.ms);
        timer.unref?.();
      }

      try {
        return await locks.request(
          info.id,
          {
            mode: "exclusive",
            ifAvailable: options.timeout?.ms === 0,
            signal: controller.signal,
          },
          async (lock) => {
            if (!lock) throw new LockTimeoutError(info, options.timeout!.ms);
            acquired = true;
            stopWaiting();
            return callback(details);
          },
        );
      } catch (error) {
        if (!acquired && timedOut) {
          throw new LockTimeoutError(info, options.timeout!.ms);
        }
        if (!acquired && options.signal?.aborted) {
          throw new LockAbortedError(info, options.signal.reason);
        }
        throw error;
      } finally {
        stopWaiting();
      }
    },
  };
}
