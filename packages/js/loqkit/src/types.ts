import type {
  LockBackendScope,
  LockOptionsInput,
  LockScope,
} from "./schemas.js";

export type ResolvedLockType = LockBackendScope | "skipped";
export type LockType = ResolvedLockType | "composite";
export type LockCallbackState =
  | "predicate-before"
  | "predicate-after"
  | "executed";
export type LockState = LockCallbackState | "timeout";

/** The enabled, disabled, or automatically skipped outcome of every layer. */
export interface ResolvedLockScope {
  readonly memory: boolean;
  readonly worker: boolean | "skipped";
  readonly flock: boolean | "skipped";
  readonly poll: boolean | "skipped";
}

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
