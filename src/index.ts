import { performance } from "node:perf_hooks";
import { prepareFileBackend } from "./backends/file.js";
import { prepareMemoryBackend } from "./backends/memory.js";
import type { PreparedBackend } from "./backends/types.js";
import { prepareWorkerBackend } from "./backends/worker.js";
import { LockAbortedError, LockTimeoutError } from "./errors.js";
import { createLockIdentity } from "./identity.js";
import {
  lockOptionsSchema,
  type ResolvedLockOptionsData,
} from "./schemas.js";
import type {
  LockAction,
  LockBackendInfo,
  LockCheckFailedHandler,
  LockContext,
  LockInfo,
  LockOptions,
  LockOutcome,
  LockPredicate,
  LockResult,
  LockStats,
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

function createContext<
  TContext extends object,
  TAcquired extends boolean,
>(
  context: TContext,
  lock: Readonly<LockInfo>,
  acquired: TAcquired,
): LockContext<TContext, TAcquired> {
  return Object.freeze({ ...context, acquired, lock }) as LockContext<
    TContext,
    TAcquired
  >;
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

function createResult<TResult>(
  value: TResult | undefined,
  lock: Readonly<LockInfo>,
  outcome: LockOutcome,
): Readonly<LockResult<TResult>> {
  const executed = outcome === "executed";
  const acquired = executed || outcome === "predicate-after";
  const stats: Readonly<LockStats> = Object.freeze({
    ...lock,
    outcome,
    acquired,
    executed,
    timedOut: outcome === "timeout",
  });
  return Object.freeze({ value, stats });
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
  options: ResolvedLockOptionsData,
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

      if (options.timeout && options.timeout.ms > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, options.timeout.ms);
        timer.unref?.();
      }

      const acquired: Readonly<LockBackendInfo>[] = [];
      const acquireAt = async (index: number): Promise<TResult> => {
        const backend = backends[index];
        if (!backend) {
          stopWaiting();
          if (timedOut) throw new LockTimeoutError(info, options.timeout!.ms);
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
        if (timedOut) throw new LockTimeoutError(info, options.timeout!.ms);
        throw error;
      } finally {
        stopWaiting();
      }
    },
  };
}

async function prepareLock(
  info: Readonly<LockInfo>,
  options: ResolvedLockOptionsData,
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
  options: ResolvedLockOptionsData,
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
  predicateOrOptions?: LockPredicate<TContext> | LockOptions<TContext>,
  suppliedOptions?: LockOptions<TContext>,
): Promise<LockResult<TResult>> => {
  const options = lockOptionsSchema.parse(
    typeof predicateOrOptions === "function"
      ? suppliedOptions
      : predicateOrOptions,
  );
  const positionalPredicate =
    typeof predicateOrOptions === "function" ? predicateOrOptions : undefined;
  const optionPredicate = options.predicate as
    | LockPredicate<TContext>
    | undefined;
  if (positionalPredicate && optionPredicate) {
    throw new TypeError(
      "Pass the predicate either positionally or as options.predicate, not both",
    );
  }
  const predicate = positionalPredicate ?? optionPredicate;
  const onCheckFailed = options.onCheckFailed as
    | LockCheckFailedHandler<TContext>
    | undefined;
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

  if (
    predicate &&
    !(await predicate(createContext(context, checkingInfo, false)))
  ) {
    await onCheckFailed?.(createContext(context, checkingInfo, false));
    return createResult(undefined, checkingInfo, "predicate-before");
  }

  const startedAt = performance.now();
  let acquiredInfo: Readonly<LockInfo> | undefined;
  let fullyAcquired = false;

  let result:
    | {
        readonly outcome: "predicate-after";
        readonly context: LockContext<TContext, true>;
      }
    | {
        readonly outcome: "executed";
        readonly value: TResult;
        readonly lock: Readonly<LockInfo>;
      };
  try {
    result = await prepared.run(async (details) => {
      fullyAcquired = true;
      acquiredInfo = createInfo(
        baseInfo,
        details,
        "acquired",
        Math.max(0, performance.now() - startedAt),
      );
      const acquiredContext = createContext(context, acquiredInfo, true);

      if (predicate && !(await predicate(acquiredContext))) {
        return {
          outcome: "predicate-after",
          context: acquiredContext,
        } as const;
      }

      const value = await action(acquiredContext);
      return {
        outcome: "executed",
        value,
        lock: acquiredInfo,
      } as const;
    });
  } catch (error) {
    if (
      error instanceof LockTimeoutError &&
      !fullyAcquired &&
      options.timeout?.error === false
    ) {
      const waitingInfo = createInfo(
        baseInfo,
        prepared.initial,
        "waiting",
        Math.max(0, performance.now() - startedAt),
      );
      return createResult(undefined, waitingInfo, "timeout");
    }
    throw error;
  }

  if (result.outcome === "predicate-after") {
    await onCheckFailed?.(result.context);
    return createResult(
      undefined,
      result.context.lock,
      "predicate-after",
    );
  }
  return createResult(result.value, result.lock, "executed");
};

/**
 * Runs an action with exclusive access to a deterministic lock.
 *
 * By default, memory, worker-thread, and cross-process file layers are held in
 * that order. When supplied, the predicate runs before waiting and again after
 * every requested layer has been acquired. Callbacks distinguish those phases
 * through context.acquired.
 */
export const withLock: WithLock = withLockImplementation;

export { LockAbortedError, LockTimeoutError, LockUnavailableError } from "./errors.js";
export { memoize } from "./memoize.js";
export {
  fileLockStrategySchema,
  lockOptionsSchema,
  lockScopeSchema,
  lockTimeoutSchema,
} from "./schemas.js";
export type {
  FileLockStrategy,
  LockTimeout,
  LockScope,
  ResolvedLockTimeout,
} from "./schemas.js";
export type {
  LockAction,
  LockBackendInfo,
  LockBackendScope,
  LockCheckFailedHandler,
  LockContext,
  LockInfo,
  LockOutcome,
  LockOptions,
  LockPredicate,
  LockResult,
  LockStats,
  ResolvedLockOptions,
  LockState,
  LockType,
  ResolvedLockType,
} from "./types.js";
