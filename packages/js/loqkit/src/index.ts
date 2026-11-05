import { performance } from "node:perf_hooks";
import {
  prepareFlockBackend,
  preparePollBackend,
} from "./backends/file.js";
import { prepareMemoryBackend } from "./backends/memory.js";
import type { PreparedBackend } from "./backends/types.js";
import { prepareWorkerBackend } from "./backends/worker.js";
import { LockAbortedError, LockTimeoutError } from "./errors.js";
import { createLockIdentity } from "./identity.js";
import {
  lockOptionsSchema,
  type NormalizedLockScope,
  type ResolvedLockOptionsData,
} from "./schemas.js";
import {
  resolveLockScope,
  selectedLockScopes,
  shouldSkipPoll,
} from "./scope.js";
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
  LockResultContext,
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
  "acquiredAt" | "backends" | "scope" | "type" | "waitedMs"
>;

function createContext<
  TContext extends object,
  TState extends LockCallbackState,
>(
  context: TContext,
  lock: Readonly<LockInfo>,
  state: TState,
): LockContext<TContext, TState> {
  return Object.freeze({ ...context, state, lock }) as LockContext<
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
  configuredScope: NormalizedLockScope,
  details: readonly Readonly<LockBackendInfo>[],
  acquired = false,
  waitedMs = 0,
): Readonly<LockInfo> {
  const backends = freezeBackends(details);
  return Object.freeze({
    ...base,
    scope: resolveLockScope(configuredScope, backends),
    type:
      backends.length === 0
        ? "skipped"
        : backends.length === 1
          ? backends[0]!.type
          : "composite",
    backends,
    waitedMs,
    ...(acquired ? { acquiredAt: new Date().toISOString() } : {}),
  });
}

function createResult<TContext extends object, TResult>(
  value: TResult | undefined,
  context: LockResultContext<TContext>,
): Readonly<LockResult<TContext, TResult>> {
  return Object.freeze({ value, context });
}

function createTimeoutContext<TContext extends object>(
  context: TContext,
  lock: Readonly<LockInfo>,
): LockResultContext<TContext> {
  return Object.freeze({
    ...context,
    state: "timeout",
    lock,
  }) as LockResultContext<TContext>;
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
        if (
          backend.initial.scope === "poll" &&
          shouldSkipPoll(options.scope, acquired)
        ) {
          acquired.push(
            Object.freeze({
              scope: "poll",
              type: "skipped",
              fallback: "native-flock-acquired",
            }),
          );
          return acquireAt(index + 1);
        }
        return backend.run(
          async (details) => {
            acquired.push(details);
            return acquireAt(index + 1);
          },
          acquired,
        );
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
  const scopes = selectedLockScopes(options.scope);
  const isLayered = scopes.length > 1;
  const effectiveOptions = isLayered
    ? { ...options, signal: controller.signal }
    : options;
  const backends: PreparedBackend[] = [];

  for (const scope of scopes) {
    switch (scope) {
      case "memory":
        backends.push(prepareMemoryBackend(info, effectiveOptions));
        break;
      case "worker":
        backends.push(prepareWorkerBackend(info, effectiveOptions));
        break;
      case "flock":
        backends.push(
          await prepareFlockBackend(info, effectiveOptions, fileBase),
        );
        break;
      case "poll":
        backends.push(preparePollBackend(info, effectiveOptions, fileBase));
        break;
    }
  }

  if (backends.length === 1) return singleBackend(backends[0]!);
  return layeredBackends(info, options, controller, backends);
}

function provisionalBackends(
  options: ResolvedLockOptionsData,
): readonly LockBackendInfo[] {
  return selectedLockScopes(options.scope).map((scope) => {
    switch (scope) {
      case "memory":
        return { scope, type: "memory" } as const;
      case "worker":
        return { scope, type: "worker" } as const;
      case "flock":
        return { scope, type: "flock" } as const;
      case "poll":
        return { scope, type: "poll" } as const;
    }
  });
}

const withLockImplementation = async <TContext extends object, TResult>(
  context: TContext,
  action: LockAction<TContext, TResult>,
  predicateOrOptions?: LockPredicate<TContext> | LockOptions<TContext>,
  suppliedOptions?: LockOptions<TContext>,
): Promise<LockResult<TContext, TResult>> => {
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
  } satisfies BaseLockInfo;

  const provisionalInfo = createInfo(
    baseInfo,
    options.scope,
    provisionalBackends(options),
  );
  const prepared = await prepareLock(provisionalInfo, options, identity.fileBase);
  const checkingInfo = createInfo(baseInfo, options.scope, prepared.initial);
  const beforeContext = createContext(
    context,
    checkingInfo,
    "predicate-before",
  );

  if (predicate && !(await predicate(beforeContext))) {
    await onCheckFailed?.(beforeContext);
    return createResult<TContext, TResult>(undefined, beforeContext);
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
        options.scope,
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
        options.scope,
        prepared.initial,
        false,
        Math.max(0, performance.now() - startedAt),
      );
      return createResult<TContext, TResult>(
        undefined,
        createTimeoutContext(context, waitingInfo),
      );
    }
    throw error;
  }

  if (result.state === "predicate-after") {
    await onCheckFailed?.(result.context);
    return createResult<TContext, TResult>(undefined, result.context);
  }
  return createResult<TContext, TResult>(result.value, result.context);
};

/**
 * Runs an action with exclusive access to a deterministic lock.
 *
 * By default, memory is required, worker-thread and native flock layers are
 * used when available, and polling is used when native flock is bypassed. When
 * supplied, the predicate runs before waiting and again after every enabled
 * layer has been handled. Callbacks distinguish those phases through
 * context.state.
 */
export const withLock: WithLock = withLockImplementation;

export { LockAbortedError, LockTimeoutError, LockUnavailableError } from "./errors.js";
export { memoize } from "./memoize.js";
export {
  lockAutoScopeSchema,
  lockBackendScopes,
  lockBackendScopeSchema,
  lockOptionsSchema,
  lockScopeSchema,
  lockTimeoutSchema,
} from "./schemas.js";
export type {
  LockBackendScope,
  LockTimeout,
  LockScope,
  NormalizedLockScope,
  ResolvedLockTimeout,
} from "./schemas.js";
export type {
  LockAction,
  LockBackendInfo,
  LockCallbackState,
  LockCheckFailedHandler,
  LockContext,
  LockInfo,
  LockOptions,
  LockPredicate,
  LockResult,
  LockResultContext,
  ResolvedLockScope,
  LockState,
  LockType,
  ResolvedLockType,
  WithLock,
} from "./types.js";
