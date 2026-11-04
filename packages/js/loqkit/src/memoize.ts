/** Runs a zero-argument factory once and reuses its successful result. */
export function memoize<T>(factory: () => PromiseLike<T>): () => Promise<T>;
export function memoize<T>(factory: () => T): () => T;
export function memoize<T>(
  factory: () => T | PromiseLike<T>,
): () => T | Promise<T>;
export function memoize<T>(
  factory: () => T | PromiseLike<T>,
): () => T | Promise<T> {
  let cache: { value: T | Promise<T> } | undefined;

  return () => {
    if (!cache) {
      const result = factory();
      if (isThenable(result)) {
        const pending = Promise.resolve(result);
        const entry = { value: pending };
        cache = entry;

        // A failed computation is retryable; only successful results stay memoized.
        void pending.then(undefined, () => {
          if (cache === entry) cache = undefined;
        });
      } else {
        cache = { value: result };
      }
    }

    return cache.value;
  };
}

function isThenable<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return Boolean(
    value !== null &&
      typeof value === "object" &&
      "then" in value &&
      typeof value.then === "function",
  );
}
