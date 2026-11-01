import { z } from "zod";

export const lockBackendScopeSchema = z.enum(["memory", "worker", "file"]);
const allBackendScopes = ["memory", "worker", "file"] as const;
const lockScopeListSchema = z
  .array(lockBackendScopeSchema)
  .min(1)
  .max(allBackendScopes.length)
  .refine((scopes) => new Set(scopes).size === scopes.length, {
    message: "Lock scopes must be unique",
  });
export const lockScopeSchema = z
  .union([lockBackendScopeSchema, lockScopeListSchema])
  .default([...allBackendScopes])
  .transform((scope) => {
    const requested = new Set(Array.isArray(scope) ? scope : [scope]);
    return Object.freeze(allBackendScopes.filter((item) => requested.has(item)));
  });
export const fileLockStrategySchema = z.enum(["auto", "flock", "poll"]);

const timeoutMsSchema = z.number().int().min(0).max(2_147_483_647);
export const lockTimeoutSchema = z
  .union([
    timeoutMsSchema,
    z
      .object({
        ms: timeoutMsSchema,
        error: z.boolean().default(true),
      })
      .strict(),
  ])
  .transform((timeout) =>
    typeof timeout === "number" ? { ms: timeout, error: true } : timeout,
  );

const abortSignalSchema = z.custom<AbortSignal>(
  (value) => typeof AbortSignal !== "undefined" && value instanceof AbortSignal,
  "Expected an AbortSignal",
);

const callbackSchema = z.custom<(...args: never[]) => unknown>(
  (value) => typeof value === "function",
  "Expected a function",
);

/** Runtime-validated options accepted by {@link withLock}. */
export const lockOptionsSchema = z
  .object({
    /** Stable input used to derive the lock id. Defaults to the supplied context. */
    key: z.unknown().optional(),
    /** Human-readable label used in diagnostics. */
    name: z.string().trim().min(1).max(200).optional(),
    /** Overrides namespace discovery from the consuming package. */
    namespace: z.string().trim().min(1).max(214).optional(),
    /** One or more lock boundaries. Omission acquires every layer. */
    scope: lockScopeSchema,
    /** Auto falls back to polling; flock requires native support; poll skips it. */
    fileStrategy: fileLockStrategySchema.default("auto"),
    /** Optional wait limit. A number throws; object form can return stats. */
    timeout: lockTimeoutSchema.optional(),
    /** Delay between polling-file lock attempts. */
    pollIntervalMs: z.number().int().min(1).max(60_000).default(100),
    /** Age after which an abandoned polling lock can be reclaimed. */
    staleMs: z.number().int().min(5_000).max(2_147_483_647).default(30_000),
    /** Overrides LOQKIT_LOCK_DIR and the operating-system temporary directory. */
    lockDirectory: z.string().trim().min(1).optional(),
    /** Starting directory for consuming-package discovery. */
    cwd: z
      .string()
      .trim()
      .min(1)
      .default(() => process.cwd()),
    /** Cancels only while waiting; an acquired action is not interrupted. */
    signal: abortSignalSchema.optional(),
    /** Runs before waiting and again after acquisition. */
    predicate: callbackSchema.optional(),
    /** Runs without a held lock after either predicate check fails. */
    onCheckFailed: callbackSchema.optional(),
  })
  .strict();

export type LockBackendScope = z.infer<typeof lockBackendScopeSchema>;
export type LockScope = LockBackendScope | readonly LockBackendScope[];
export type ResolvedLockScope = z.output<typeof lockScopeSchema>;
export type FileLockStrategy = z.infer<typeof fileLockStrategySchema>;
export type LockTimeout = z.input<typeof lockTimeoutSchema>;
export type ResolvedLockTimeout = z.output<typeof lockTimeoutSchema>;
export type LockOptionsInput = z.input<typeof lockOptionsSchema>;
export type ResolvedLockOptionsData = z.output<typeof lockOptionsSchema>;
