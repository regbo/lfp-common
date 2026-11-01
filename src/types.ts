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
export type LockState =
  | "predicate-before"
  | "predicate-after"
  | "executed"
  | "timeout";
export type LockCallbackState = Exclude<LockState, "timeout">;

type LockAcquired<TState extends LockState> = TState extends
  | "predicate-before"
  | "timeout"
  ? false
  : true;

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
  Omit<TContext, "acquired" | "lock" | "state"> & {
    /** Which branch of the lock attempt is invoking this callback. */
    readonly state: TState;
    /** Whether this context snapshot was created after lock acquisition. */
    readonly acquired: LockAcquired<TState>;
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

/** Lock metadata plus the terminal state of one withLock attempt. */
export interface LockStats extends LockInfo {
  readonly state: LockState;
  readonly acquired: boolean;
  readonly executed: boolean;
  readonly timedOut: boolean;
}

/** The action value and statistics for one withLock attempt. */
export interface LockResult<TResult> {
  readonly value: TResult | undefined;
  readonly stats: Readonly<LockStats>;
}

export interface WithLock {
  <TContext extends object, TResult>(
    context: TContext,
    action: LockAction<TContext, TResult>,
    options?: LockOptions<TContext>,
  ): Promise<LockResult<TResult>>;

  <TContext extends object, TResult>(
    context: TContext,
    action: LockAction<TContext, TResult>,
    predicate: LockPredicate<TContext>,
    options?: LockOptions<TContext>,
  ): Promise<LockResult<TResult>>;
}
