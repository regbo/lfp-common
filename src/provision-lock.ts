import { withLock } from 'loqkit';

export interface ProvisioningLockOptions<T> {
  /** Stable logical identity shared by every caller of the protected resource. */
  key: string;
  timeoutMs: number;
  check: () => Promise<T | null>;
  mutate: () => Promise<T>;
}

/** Use Loqkit's layered lock and predicate checks for one idempotent mutation. */
export async function withProvisioningLock<T>(
  options: ProvisioningLockOptions<T>,
): Promise<T> {
  let existing: { value: T } | undefined;
  const result = await withLock(
    { resource: options.key },
    options.mutate,
    {
      key: options.key,
      name: 'Pyfig provisioning',
      namespace: 'pyfig',
      timeout: options.timeoutMs,
      predicate: async () => {
        const value = await options.check();
        if (value === null) return true;
        existing = { value };
        return false;
      },
    },
  );

  if (result.context.state === 'executed') return result.value as T;
  if (existing) return existing.value;
  throw new Error(`Provisioning check for ${options.key} did not produce a resource.`);
}
