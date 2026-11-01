import { Mutex } from "async-mutex";
import { z } from "zod";

export const lockOptionsSchema = z
  .object({
    key: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
  })
  .strict();

export type LockOptions = z.input<typeof lockOptionsSchema>;
export type LockState = "checking" | "acquired";

export interface LockInfo {
  readonly key: string;
  readonly name: string;
  readonly type: "memory";
  readonly state: LockState;
}

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
  | { readonly executed: true; readonly value: TResult }
  | {
      readonly executed: false;
      readonly reason: "predicate-before" | "predicate-after";
    };

const mutexes = new Map<string, Mutex>();

function contextWithLock<TContext extends object>(
  context: TContext,
  lock: LockInfo,
): LockContext<TContext> {
  return Object.freeze({ ...context, lock }) as LockContext<TContext>;
}

function defaultKey(context: object): string {
  return JSON.stringify(context);
}

/** Runs an action exclusively. A predicate is checked before and after acquisition. */
export async function withLock<TContext extends object, TResult>(
  context: TContext,
  action: LockAction<TContext, TResult>,
  predicate?: LockPredicate<TContext>,
  suppliedOptions?: LockOptions,
): Promise<LockRunResult<TResult>> {
  const options = lockOptionsSchema.parse(suppliedOptions);
  const key = options.key ?? defaultKey(context);
  const name = options.name ?? key;
  const checking = contextWithLock(context, {
    key,
    name,
    type: "memory",
    state: "checking",
  });

  if (predicate && !(await predicate(checking))) {
    return { executed: false, reason: "predicate-before" };
  }

  let mutex = mutexes.get(key);
  if (!mutex) {
    mutex = new Mutex();
    mutexes.set(key, mutex);
  }

  return mutex.runExclusive(async () => {
    const acquired = contextWithLock(context, {
      key,
      name,
      type: "memory",
      state: "acquired",
    });

    if (predicate && !(await predicate(acquired))) {
      return { executed: false, reason: "predicate-after" };
    }

    return { executed: true, value: await action(acquired) };
  });
}
