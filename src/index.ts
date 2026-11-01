import { performance } from "node:perf_hooks";
import { prepareFileBackend } from "./backends/file.js";
import { prepareMemoryBackend } from "./backends/memory.js";
import type { PreparedBackend } from "./backends/types.js";
import { prepareWorkerBackend } from "./backends/worker.js";
import { LockAbortedError, LockTimeoutError } from "./errors.js";
import { createLockIdentity } from "./identity.js";
import {
  type LockOptions,
  lockOptionsSchema,
  type ResolvedLockOptions,
} from "./schemas.js";
import type {
  LockAction,
  LockBackendInfo,
  LockContext,
  LockInfo,
  LockPredicate,
  LockRunResult,
  WithLock,
} from "./types.js";

interface PreparedLock {
  readonly initial: readonly Readonly<LockBackendInfo>[];
  run<TResult>(
    callback: (
      details: readonly Readonly<LockBackendInfo>[],
    ) => Promise<TResult>,
  ): Promise<TResult>;
}

type BaseLockInfo = Omit<
  LockInfo,
  "acquiredAt" | "backends" | "state" | "type" | "waitedMs"
>;

function createContext<TContext extends object>(
  context: TContext,
  lock: Readonly<LockInfo>,
): LockContext<TContext> {
  return Object.freeze({ ...context, lock }) as LockContext<TContext>;
}

function freezeBackends(
  backends: readonly Readonly<LockBackendInfo>[],
): readonly Readonly<LockBackendInfo>[] {
  return Object.freeze(backends.map((backend) => Object.freeze({ ...backend })));
}

function createInfo(
  base: BaseLockInfo,
  details: readonly Readonly<LockBackendInfo>[],
  state: LockInfo["state"],
  waitedMs = 0,
): Readonly<LockInfo> {
  const backends = freezeBackends(details);
  return Object.freeze({
    ...base,
    type: backends.length === 1 ? backends[0]!.type : "composite",
    backends,
    state,
    waitedMs,
    ...(state === "acquired" ? { acquiredAt: new Date().toISOString() } : {}),
  });
}

function singleBackend(backend: PreparedBackend): PreparedLock {
  return {
    initial: [backend.initial],
    async run<TResult>(
      callback: (
        details: readonly Readonly<LockBackendInfo>[],
      ) => Promise<TResult>,
    ): Promise<TResult> {
      return backend.run((details) => callback([details]));
    },
  };
}

function layeredBackends(
  info: Readonly<LockInfo>,
  options: ResolvedLockOptions,
  controller: AbortController,
  backends: readonly PreparedBackend[],
): PreparedLock {
  return {
    initial: backends.map((backend) => backend.initial),
    async run<TResult>(
      callback: (
        details: readonly Readonly<LockBackendInfo>[],
      ) => Promise<TResult>,
    ): Promise<TResult> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      const abortFromCaller = () => controller.abort(options.signal?.reason);

      const stopWaiting = () => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        options.signal?.removeEventListener("abort", abortFromCaller);
      };

      if (options.signal?.aborted) {
        throw new LockAbortedError(info, options.signal.reason);
      }
      options.signal?.addEventListener("abort", abortFromCaller, { once: true });

      if (options.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, options.timeoutMs);
        timer.unref?.();
      }

      const acquired: Readonly<LockBackendInfo>[] = [];
      const acquireAt = async (index: number): Promise<TResult> => {
        const backend = backends[index];
        if (!backend) {
          stopWaiting();
          if (timedOut) throw new LockTimeoutError(info, options.timeoutMs);
          if (options.signal?.aborted) {
            throw new LockAbortedError(info, options.signal.reason);
          }
          return callback(acquired);
        }
        return backend.run(async (details) => {
          acquired.push(details);
          return acquireAt(index + 1);
        });
      };

      try {
        return await acquireAt(0);
      } catch (error) {
        if (timedOut) throw new LockTimeoutError(info, options.timeoutMs);
        throw error;
      } finally {
        stopWaiting();
      }
    },
  };
}

async function prepareLock(
  info: Readonly<LockInfo>,
  options: ResolvedLockOptions,
  fileBase: string,
): Promise<PreparedLock> {
  switch (options.scope) {
    case "memory":
      return singleBackend(prepareMemoryBackend(info, options));
    case "worker":
      return singleBackend(prepareWorkerBackend(info, options));
    case "file":
      return singleBackend(await prepareFileBackend(info, options, fileBase));
    case "all": {
      const controller = new AbortController();
      const layeredOptions = { ...options, signal: controller.signal };
      const backends = [
        prepareMemoryBackend(info, layeredOptions),
        prepareWorkerBackend(info, layeredOptions, true),
        await prepareFileBackend(info, layeredOptions, fileBase),
      ];
      return layeredBackends(info, options, controller, backends);
    }
  }
}

function provisionalBackends(
  options: ResolvedLockOptions,
): readonly LockBackendInfo[] {
  const fileType = options.fileStrategy === "poll" ? "poll" : "flock";
  switch (options.scope) {
    case "memory":
      return [{ scope: "memory", type: "memory" }];
    case "worker":
      return [{ scope: "worker", type: "worker" }];
    case "file":
      return [{ scope: "file", type: fileType }];
    case "all":
      return [
        { scope: "memory", type: "memory" },
        { scope: "worker", type: "worker" },
        { scope: "file", type: fileType },
      ];
  }
}

const withLockImplementation = async <TContext extends object, TResult>(
  context: TContext,
  action: LockAction<TContext, TResult>,
  predicateOrOptions?: LockPredicate<TContext> | LockOptions,
  suppliedOptions?: LockOptions,
): Promise<LockRunResult<TResult>> => {
  const predicate =
    typeof predicateOrOptions === "function" ? predicateOrOptions : undefined;
  const options = lockOptionsSchema.parse(
    typeof predicateOrOptions === "function"
      ? suppliedOptions
      : predicateOrOptions,
  );
  const identity = await createLockIdentity(context, options);
  const baseInfo = {
    id: identity.id,
    name: identity.name,
    namespace: identity.namespace,
    scope: options.scope,
    ...(options.scope === "all" || options.scope === "file"
      ? { strategy: options.fileStrategy }
      : {}),
  } satisfies BaseLockInfo;

  const provisionalInfo = createInfo(
    baseInfo,
    provisionalBackends(options),
    "checking",
  );
  const prepared = await prepareLock(provisionalInfo, options, identity.fileBase);
  const checkingInfo = createInfo(baseInfo, prepared.initial, "checking");

  if (predicate && !(await predicate(createContext(context, checkingInfo)))) {
    return { executed: false, reason: "predicate-before", lock: checkingInfo };
  }

  const startedAt = performance.now();
  let acquiredInfo: Readonly<LockInfo> | undefined;

  return prepared.run(async (details) => {
    acquiredInfo = createInfo(
      baseInfo,
      details,
      "acquired",
      Math.max(0, performance.now() - startedAt),
    );
    const acquiredContext = createContext(context, acquiredInfo);

    if (predicate && !(await predicate(acquiredContext))) {
      return {
        executed: false,
        reason: "predicate-after",
        lock: acquiredInfo,
      };
    }

    const value = await action(acquiredContext);
    return { executed: true, value, lock: acquiredInfo };
  });
};

/**
 * Runs an action with exclusive access to a deterministic lock.
 *
 * By default, memory, worker-thread, and cross-process file layers are held in
 * that order. When supplied, the predicate runs before waiting and again after
 * every requested layer has been acquired.
 */
export const withLock: WithLock = withLockImplementation;

export { LockAbortedError, LockTimeoutError, LockUnavailableError } from "./errors.js";
export { memoize } from "./memoize.js";
export {
  fileLockStrategySchema,
  lockOptionsSchema,
  lockScopeSchema,
} from "./schemas.js";
export type {
  FileLockStrategy,
  LockOptions,
  LockScope,
  ResolvedLockOptions,
} from "./schemas.js";
export type {
  LockAction,
  LockBackendInfo,
  LockBackendScope,
  LockContext,
  LockInfo,
  LockPredicate,
  LockRunResult,
  LockState,
  LockType,
  ResolvedLockType,
} from "./types.js";
