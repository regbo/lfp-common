import type { FileLockStrategy, LockOptions, LockScope } from "./schemas.js";

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
export type LockContext<TContext extends object> = Readonly<
  Omit<TContext, "lock"> & { readonly lock: Readonly<LockInfo> }
>;

export type LockAction<TContext extends object, TResult> = (
  context: LockContext<TContext>,
) => TResult | PromiseLike<TResult>;

export type LockPredicate<TContext extends object> = (
  context: LockContext<TContext>,
) => boolean | PromiseLike<boolean>;

export type LockRunResult<TResult> =
  | {
      readonly executed: true;
      readonly value: TResult;
      readonly lock: Readonly<LockInfo>;
    }
  | {
      readonly executed: false;
      readonly reason: "predicate-before" | "predicate-after";
      readonly lock: Readonly<LockInfo>;
    };

export interface WithLock {
  <TContext extends object, TResult>(
    context: TContext,
    action: LockAction<TContext, TResult>,
    options?: LockOptions,
  ): Promise<LockRunResult<TResult>>;

  <TContext extends object, TResult>(
    context: TContext,
    action: LockAction<TContext, TResult>,
    predicate: LockPredicate<TContext>,
    options?: LockOptions,
  ): Promise<LockRunResult<TResult>>;
}
