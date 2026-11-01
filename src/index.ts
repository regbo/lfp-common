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
  LockCallbackState,
  LockCheckFailedHandler,
  LockContext,
  LockInfo,
  LockOptions,
  LockPredicate,
  LockResult,
  LockState,
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
  "acquiredAt" | "backends" | "type" | "waitedMs"
>;

function createContext<
  TContext extends object,
  TState extends LockCallbackState,
>(
  context: TContext,
  lock: Readonly<LockInfo>,
  state: TState,
): LockContext<TContext, TState> {
  const acquired = state !== "predicate-before";
  return Object.freeze({ ...context, state, acquired, lock }) as LockContext<
    TContext,
    TState
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
  acquired = false,
  waitedMs = 0,
): Readonly<LockInfo> {
  const backends = freezeBackends(details);
  return Object.freeze({
    ...base,
    type: backends.length === 1 ? backends[0]!.type : "composite",
    backends,
    waitedMs,
    ...(acquired ? { acquiredAt: new Date().toISOString() } : {}),
  });
}

function createResult<TResult>(
  value: TResult | undefined,
  lock: Readonly<LockInfo>,
  state: LockState,
): Readonly<LockResult<TResult>> {
  const executed = state === "executed";
  const acquired = executed || state === "predicate-after";
  const stats: Readonly<LockStats> = Object.freeze({
    ...lock,
    state,
    acquired,
    executed,
    timedOut: state === "timeout",
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
  const controller = new AbortController();
  const isLayered = options.scope.length > 1;
  const effectiveOptions = isLayered
    ? { ...options, signal: controller.signal }
    : options;
  const fileLayerSelected = options.scope.includes("file");
  const backends: PreparedBackend[] = [];

  for (const scope of options.scope) {
    switch (scope) {
      case "memory":
        backends.push(prepareMemoryBackend(info, effectiveOptions));
        break;
      case "worker":
        backends.push(
          prepareWorkerBackend(info, effectiveOptions, fileLayerSelected),
        );
        break;
      case "file":
        backends.push(
          await prepareFileBackend(info, effectiveOptions, fileBase),
        );
        break;
    }
  }

  if (backends.length === 1) return singleBackend(backends[0]!);
  return layeredBackends(info, options, controller, backends);
}

function provisionalBackends(
  options: ResolvedLockOptionsData,
): readonly LockBackendInfo[] {
  const fileType = options.fileStrategy === "poll" ? "poll" : "flock";
  return options.scope.map((scope) => {
    switch (scope) {
      case "memory":
        return { scope, type: "memory" } as const;
      case "worker":
        return { scope, type: "worker" } as const;
      case "file":
        return { scope, type: fileType } as const;
    }
  });
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
    ...(options.scope.includes("file")
      ? { strategy: options.fileStrategy }
      : {}),
  } satisfies BaseLockInfo;

  const provisionalInfo = createInfo(baseInfo, provisionalBackends(options));
  const prepared = await prepareLock(provisionalInfo, options, identity.fileBase);
  const checkingInfo = createInfo(baseInfo, prepared.initial);
  const beforeContext = createContext(
    context,
    checkingInfo,
    "predicate-before",
  );

  if (predicate && !(await predicate(beforeContext))) {
    await onCheckFailed?.(beforeContext);
    return createResult(undefined, beforeContext.lock, beforeContext.state);
  }

  const startedAt = performance.now();
  let fullyAcquired = false;

  let result:
    | {
        readonly state: "predicate-after";
        readonly context: LockContext<TContext, "predicate-after">;
      }
    | {
        readonly state: "executed";
        readonly value: TResult;
        readonly context: LockContext<TContext, "executed">;
      };
  try {
    result = await prepared.run(async (details) => {
      fullyAcquired = true;
      const acquiredInfo = createInfo(
        baseInfo,
        details,
        true,
        Math.max(0, performance.now() - startedAt),
      );
      const predicateContext = createContext(
        context,
        acquiredInfo,
        "predicate-after",
      );

      if (predicate && !(await predicate(predicateContext))) {
        return {
          state: "predicate-after",
          context: predicateContext,
        } as const;
      }

      const actionContext = createContext(context, acquiredInfo, "executed");
      const value = await action(actionContext);
      return {
        state: "executed",
        value,
        context: actionContext,
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
        false,
        Math.max(0, performance.now() - startedAt),
      );
      return createResult(undefined, waitingInfo, "timeout");
    }
    throw error;
  }

  if (result.state === "predicate-after") {
    await onCheckFailed?.(result.context);
    return createResult(
      undefined,
      result.context.lock,
      result.context.state,
    );
  }
  return createResult(result.value, result.context.lock, result.context.state);
};

/**
 * Runs an action with exclusive access to a deterministic lock.
 *
 * By default, memory, worker-thread, and cross-process file layers are held in
 * that order. When supplied, the predicate runs before waiting and again after
 * every requested layer has been acquired. Callbacks distinguish those phases
 * through context.state; context.acquired is the corresponding convenience
 * boolean.
 */
export const withLock: WithLock = withLockImplementation;

export { LockAbortedError, LockTimeoutError, LockUnavailableError } from "./errors.js";
export { memoize } from "./memoize.js";
export {
  fileLockStrategySchema,
  lockBackendScopeSchema,
  lockOptionsSchema,
  lockScopeSchema,
  lockTimeoutSchema,
} from "./schemas.js";
export type {
  FileLockStrategy,
  LockTimeout,
  LockScope,
  ResolvedLockScope,
  ResolvedLockTimeout,
} from "./schemas.js";
export type {
  LockAction,
  LockBackendInfo,
  LockBackendScope,
  LockCallbackState,
  LockCheckFailedHandler,
  LockContext,
  LockInfo,
  LockOptions,
  LockPredicate,
  LockResult,
  LockStats,
  ResolvedLockOptions,
  LockState,
  LockType,
  ResolvedLockType,
} from "./types.js";
