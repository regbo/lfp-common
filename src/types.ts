import type {
  FileLockStrategy,
  LockBackendScope as SchemaLockBackendScope,
  LockOptionsInput,
  LockScope,
  ResolvedLockScope,
  ResolvedLockOptionsData,
} from "./schemas.js";

export type LockBackendScope = SchemaLockBackendScope;
export type ResolvedLockType =
  | "memory"
  | "worker"
  | "flock"
  | "poll"
  | "skipped";
export type LockType = ResolvedLockType | "composite";
export type LockCallbackState =
  | "predicate-before"
  | "predicate-after"
  | "executed";
export type LockState = LockCallbackState | "timeout";

/** One requested lock layer and the implementation that satisfied it. */
export interface LockBackendInfo {
  readonly scope: LockBackendScope;
  readonly type: ResolvedLockType;
  readonly file?: string;
  readonly fallback?: string;
}

/** Details about the resource and implementations used for a lock. */
export interface LockInfo {
  readonly id: string;
  readonly name: string;
  readonly namespace: string;
  readonly scope: ResolvedLockScope;
  readonly type: LockType;
  readonly backends: readonly Readonly<LockBackendInfo>[];
  readonly strategy?: FileLockStrategy;
  readonly waitedMs: number;
  readonly acquiredAt?: string;
}

/** The caller context plus immutable information about the current lock. */
export type LockContext<
  TContext extends object,
  TState extends LockCallbackState = LockCallbackState,
> = Readonly<
  Omit<TContext, "lock" | "state"> & {
    /** Which branch of the lock attempt is invoking this callback. */
    readonly state: TState;
    readonly lock: Readonly<LockInfo>;
  }
>;

export type LockAction<TContext extends object, TResult> = (
  context: LockContext<TContext, "executed">,
) => TResult | PromiseLike<TResult>;

export type LockPredicate<TContext extends object> = (
  context: LockContext<TContext, "predicate-before" | "predicate-after">,
) => boolean | PromiseLike<boolean>;

export type LockCheckFailedHandler<TContext extends object> = (
  context: LockContext<TContext, "predicate-before" | "predicate-after">,
) => void | PromiseLike<void>;

interface LockCallbacks<TContext extends object> {
  readonly predicate?: LockPredicate<TContext>;
  readonly onCheckFailed?: LockCheckFailedHandler<TContext>;
}

/** Lock configuration with callbacks typed to the supplied context. */
export type LockOptions<TContext extends object = object> = Omit<
  LockOptionsInput,
  "onCheckFailed" | "predicate" | "scope"
> & {
  readonly scope?: LockScope;
} &
  LockCallbacks<TContext>;

/** Runtime-resolved lock configuration with context-aware callbacks. */
export type ResolvedLockOptions<TContext extends object = object> = Omit<
  ResolvedLockOptionsData,
  "onCheckFailed" | "predicate" | "scope"
> & {
  readonly scope: ResolvedLockScope;
} &
  LockCallbacks<TContext>;

/** A callback context widened with the timeout state only results can observe. */
export type LockResultContext<TContext extends object> = Readonly<
  Omit<LockContext<TContext>, "state"> & {
    readonly state: LockState;
  }
>;

/** The action value and terminal context for one withLock attempt. */
export interface LockResult<TContext extends object, TResult> {
  readonly value: TResult | undefined;
  readonly context: LockResultContext<TContext>;
}

export interface WithLock {
  <TContext extends object, TResult>(
    context: TContext,
    action: LockAction<TContext, TResult>,
    options?: LockOptions<TContext>,
  ): Promise<LockResult<TContext, TResult>>;

  <TContext extends object, TResult>(
    context: TContext,
    action: LockAction<TContext, TResult>,
    predicate: LockPredicate<TContext>,
    options?: LockOptions<TContext>,
  ): Promise<LockResult<TContext, TResult>>;
}
