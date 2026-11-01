import type {
  FileLockStrategy,
  LockOptionsInput,
  LockScope,
  ResolvedLockOptionsData,
} from "./schemas.js";

export type LockBackendScope = Exclude<LockScope, "all">;
export type ResolvedLockType = "memory" | "worker" | "flock" | "poll";
export type LockType = ResolvedLockType | "composite";
export type LockState = "checking" | "waiting" | "acquired";

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
  readonly scope: LockScope;
  readonly type: LockType;
  readonly backends: readonly Readonly<LockBackendInfo>[];
  readonly state: LockState;
  readonly strategy?: FileLockStrategy;
  readonly waitedMs: number;
  readonly acquiredAt?: string;
}

/** The caller context plus immutable information about the current lock. */
export type LockContext<
  TContext extends object,
  TAcquired extends boolean = boolean,
> = Readonly<
  Omit<TContext, "acquired" | "lock"> & {
    /** Whether this context snapshot was created after lock acquisition. */
    readonly acquired: TAcquired;
    readonly lock: Readonly<LockInfo>;
  }
>;

export type LockAction<TContext extends object, TResult> = (
  context: LockContext<TContext, true>,
) => TResult | PromiseLike<TResult>;

export type LockPredicate<TContext extends object> = (
  context: LockContext<TContext>,
) => boolean | PromiseLike<boolean>;

export type LockCheckFailedHandler<TContext extends object> = (
  context: LockContext<TContext>,
) => void | PromiseLike<void>;

interface LockCallbacks<TContext extends object> {
  readonly predicate?: LockPredicate<TContext>;
  readonly onCheckFailed?: LockCheckFailedHandler<TContext>;
}

/** Lock configuration with callbacks typed to the supplied context. */
export type LockOptions<TContext extends object = object> = Omit<
  LockOptionsInput,
  "onCheckFailed" | "predicate"
> &
  LockCallbacks<TContext>;

/** Runtime-resolved lock configuration with context-aware callbacks. */
export type ResolvedLockOptions<TContext extends object = object> = Omit<
  ResolvedLockOptionsData,
  "onCheckFailed" | "predicate"
> &
  LockCallbacks<TContext>;

type LockOptionsWithoutPredicate<TContext extends object> = Omit<
  LockOptions<TContext>,
  "predicate"
> & { readonly predicate?: never };

type LockOptionsWithPredicate<TContext extends object> = Omit<
  LockOptions<TContext>,
  "predicate"
> & { readonly predicate: LockPredicate<TContext> };

export interface WithLock {
  <TContext extends object, TResult>(
    context: TContext,
    action: LockAction<TContext, TResult>,
    options?: LockOptionsWithoutPredicate<TContext>,
  ): Promise<TResult>;

  <TContext extends object, TResult>(
    context: TContext,
    action: LockAction<TContext, TResult>,
    options: LockOptionsWithPredicate<TContext>,
  ): Promise<TResult | undefined>;

  <TContext extends object, TResult>(
    context: TContext,
    action: LockAction<TContext, TResult>,
    options: LockOptions<TContext>,
  ): Promise<TResult | undefined>;

  <TContext extends object, TResult>(
    context: TContext,
    action: LockAction<TContext, TResult>,
    predicate: LockPredicate<TContext>,
    options?: LockOptions<TContext>,
  ): Promise<TResult | undefined>;
}
