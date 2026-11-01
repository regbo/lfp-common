import {
  withLock,
  type LockAction,
  type LockOptions,
  type LockPredicate,
  type LockResult,
} from 'loqkit';

export async function withPynectLock<TContext extends object, TResult>(
  context: TContext,
  action: LockAction<TContext, TResult>,
  predicate?: LockPredicate<TContext>,
  options?: LockOptions<TContext>,
): Promise<LockResult<TContext, TResult>> {
  return predicate
    ? withLock(context, action, predicate, options)
    : withLock(context, action, options);
}
