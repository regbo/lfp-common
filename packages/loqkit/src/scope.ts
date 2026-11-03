import {
  lockBackendScopes,
  type NormalizedLockScope,
} from "./schemas.js";
import type {
  LockBackendInfo,
  LockBackendScope,
  ResolvedLockScope,
} from "./types.js";

/** Returns enabled and automatic layers in their canonical acquisition order. */
export function selectedLockScopes(
  configured: NormalizedLockScope,
): readonly LockBackendScope[] {
  return lockBackendScopes.filter((scope) => configured[scope] !== false);
}

/** Resolves automatic configuration to the outcome exposed on lock contexts. */
export function resolveLockScope(
  configured: NormalizedLockScope,
  backends: readonly Readonly<LockBackendInfo>[],
): Readonly<ResolvedLockScope> {
  const outcome = (scope: "worker" | "flock" | "poll") => {
    if (configured[scope] === false) return false;
    return backends.find((backend) => backend.scope === scope)?.type ===
      "skipped"
      ? "skipped"
      : true;
  };

  return Object.freeze({
    memory: configured.memory,
    worker: outcome("worker"),
    flock: outcome("flock"),
    poll: outcome("poll"),
  });
}

/** Whether an automatic polling layer is redundant after native acquisition. */
export function shouldSkipPoll(
  configured: NormalizedLockScope,
  acquired: readonly Readonly<LockBackendInfo>[],
): boolean {
  return (
    configured.poll === "auto" &&
    acquired.some(
      (backend) => backend.scope === "flock" && backend.type === "flock",
    )
  );
}
