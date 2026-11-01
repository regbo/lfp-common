import { z } from "zod";

export const lockScopeSchema = z.enum(["all", "memory", "worker", "file"]);
export const fileLockStrategySchema = z.enum(["auto", "flock", "poll"]);

const abortSignalSchema = z.custom<AbortSignal>(
  (value) => typeof AbortSignal !== "undefined" && value instanceof AbortSignal,
  "Expected an AbortSignal",
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
    /** Lock boundary. The default acquires memory, worker, and file layers. */
    scope: lockScopeSchema.default("all"),
    /** Auto falls back to polling; flock requires native support; poll skips it. */
    fileStrategy: fileLockStrategySchema.default("auto"),
    /** Maximum total time spent waiting. Zero performs one immediate attempt. */
    timeoutMs: z.number().int().min(0).max(2_147_483_647).default(30_000),
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
  })
  .strict();

export type LockScope = z.infer<typeof lockScopeSchema>;
export type FileLockStrategy = z.infer<typeof fileLockStrategySchema>;
export type LockOptions = z.input<typeof lockOptionsSchema>;
export type ResolvedLockOptions = z.output<typeof lockOptionsSchema>;
