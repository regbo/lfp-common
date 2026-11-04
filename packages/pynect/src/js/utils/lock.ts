import { withLock as withLoqkitLock } from 'loqkit';

const lockIds = new WeakMap<object, number>();
let nextLockId = 0;

/** Run an action after checking its predicate before and after acquiring a context-scoped lock. */
export async function withLock<Context extends object, Value>(
  context: Context,
  predicate: (context: Context) => boolean | PromiseLike<boolean>,
  action: (context: Context) => Value | PromiseLike<Value>,
): Promise<Value | undefined> {
  let key = lockIds.get(context);
  if (key === undefined) {
    key = nextLockId++;
    lockIds.set(context, key);
  }
  const result = await withLoqkitLock(
    { context },
    () => action(context),
    {
      key,
      namespace: 'pynect',
      predicate: () => predicate(context),
      scope: { memory: true, worker: false, flock: false, poll: false },
    },
  );
  return result.value;
}
