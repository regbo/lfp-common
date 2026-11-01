interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

const completed = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<unknown>>();
let cacheGeneration = 0;

/**
 * Share expensive resolution work within one JavaScript realm without treating
 * cached filesystem state as permanent truth.
 */
export async function memoizeAsync<T>(
  namespace: string,
  key: string,
  ttlMs: number,
  validate: (value: T) => boolean | Promise<boolean>,
  load: () => Promise<T>,
): Promise<T> {
  const cacheKey = `${namespace}\0${key}`;
  const cached = completed.get(cacheKey);
  if (cached && cached.expiresAt >= Date.now()) {
    try {
      if (await validate(cached.value as T)) return cached.value as T;
    } catch {
      // Invalid or inaccessible external state is refreshed below.
    }
    completed.delete(cacheKey);
  }

  const pending = inFlight.get(cacheKey);
  if (pending) return pending as Promise<T>;

  const generation = cacheGeneration;
  const loading = load().then((value) => {
    if (ttlMs > 0 && generation === cacheGeneration) {
      completed.set(cacheKey, { expiresAt: Date.now() + ttlMs, value });
    }
    return value;
  }).finally(() => {
    if (inFlight.get(cacheKey) === loading) inFlight.delete(cacheKey);
  });
  inFlight.set(cacheKey, loading);
  return loading;
}

/** Synchronous counterpart used by spawnSync bridges in the caller realm. */
export function memoizeSync<T>(
  namespace: string,
  key: string,
  ttlMs: number,
  validate: (value: T) => boolean,
  load: () => T,
): T {
  const cacheKey = `${namespace}\0${key}`;
  const cached = completed.get(cacheKey);
  if (cached && cached.expiresAt >= Date.now()) {
    try {
      if (validate(cached.value as T)) return cached.value as T;
    } catch {
      // Refresh invalid external state below.
    }
    completed.delete(cacheKey);
  }
  const value = load();
  if (ttlMs > 0) completed.set(cacheKey, { expiresAt: Date.now() + ttlMs, value });
  return value;
}

/** Clear completed and in-flight lookup references after external toolchain changes. */
export function clearPyfigCaches(): void {
  cacheGeneration += 1;
  completed.clear();
  inFlight.clear();
}
