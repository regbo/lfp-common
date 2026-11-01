import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { LockUnavailableError } from "../errors.js";
import type { ResolvedLockOptionsData } from "../schemas.js";
import type { LockBackendInfo, LockInfo } from "../types.js";
import { throwIfAborted, waitForRetry } from "../waiting.js";
import { prepareSkippedBackend, type PreparedBackend } from "./types.js";

interface FsExt {
  flock(
    fileDescriptor: number,
    flags: "exnb" | "un",
    callback: (error?: NodeJS.ErrnoException | null) => void,
  ): void;
}

interface FileBackendDependencies {
  readonly loadFsExt: () => Promise<FsExt | undefined>;
}

async function loadFsExt(): Promise<FsExt | undefined> {
  if (process.platform === "win32") return undefined;

  try {
    const imported = (await import("fs-ext")) as unknown as {
      default?: FsExt;
      flock?: FsExt["flock"];
    };
    const candidate = imported.flock
      ? ({ flock: imported.flock } satisfies FsExt)
      : imported.default;
    return candidate && typeof candidate.flock === "function"
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

function callFlock(
  fsExt: FsExt,
  fileDescriptor: number,
  flags: "exnb" | "un",
): Promise<void> {
  return new Promise((resolve, reject) => {
    fsExt.flock(fileDescriptor, flags, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function isBusy(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EAGAIN" || code === "EWOULDBLOCK" || code === "EACCES";
}

function isPollingContention(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ELOCKED";
}

function preparePollingBackend(
  info: Readonly<LockInfo>,
  options: ResolvedLockOptionsData,
  file: string,
): PreparedBackend {
  const target = `${file}.target`;
  const details = {
    scope: "poll",
    type: "poll",
    file,
  } as const satisfies LockBackendInfo;

  return {
    initial: details,
    async run<TResult>(
      callback: (details: Readonly<LockBackendInfo>) => Promise<TResult>,
      acquired: readonly Readonly<LockBackendInfo>[] = [],
    ): Promise<TResult> {
      await mkdir(dirname(file), { recursive: true });
      const targetHandle = await open(target, "a");
      await targetHandle.close();
      const startedAt = Date.now();

      while (true) {
        throwIfAborted(options.signal, info);
        let release: (() => Promise<void>) | undefined;
        try {
          release = await lockfile.lock(target, {
            lockfilePath: file,
            realpath: false,
            retries: 0,
            stale: options.staleMs,
          });
        } catch (error) {
          if (!isPollingContention(error)) throw error;
          if (
            acquired.some(
              (backend) =>
                backend.scope === "flock" && backend.type === "flock",
            )
          ) {
            throw new LockUnavailableError(
              info,
              "poll lock is contended while native flock is already held",
              error,
            );
          }
          await waitForRetry(
            startedAt,
            options.timeout?.ms,
            options.pollIntervalMs,
            options.signal,
            info,
          );
          continue;
        }

        try {
          return await callback(details);
        } finally {
          await release();
        }
      }
    },
  };
}

function createFlockBackend(
  fsExt: FsExt,
  info: Readonly<LockInfo>,
  options: ResolvedLockOptionsData,
  file: string,
): PreparedBackend {
  const details = {
    scope: "flock",
    type: "flock",
    file,
  } as const satisfies LockBackendInfo;

  return {
    initial: details,
    async run<TResult>(
      callback: (details: Readonly<LockBackendInfo>) => Promise<TResult>,
    ): Promise<TResult> {
      await mkdir(dirname(file), { recursive: true });
      const handle = await open(file, "a+");
      const startedAt = Date.now();

      try {
        while (true) {
          throwIfAborted(options.signal, info);
          try {
            await callFlock(fsExt, handle.fd, "exnb");
            break;
          } catch (error) {
            if (isBusy(error)) {
              await waitForRetry(
                startedAt,
                options.timeout?.ms,
                options.pollIntervalMs,
                options.signal,
                info,
              );
              continue;
            }

            if (options.scope.flock === "auto") {
              const skipped = {
                scope: "flock",
                type: "skipped",
                file,
                fallback: "native-flock-failed",
              } as const satisfies LockBackendInfo;
              await handle.close();
              return callback(skipped);
            }
            throw new LockUnavailableError(
              info,
              "native flock acquisition failed",
              error,
            );
          }
        }

        try {
          return await callback(details);
        } finally {
          await callFlock(fsExt, handle.fd, "un");
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
    },
  };
}

export function preparePollBackend(
  info: Readonly<LockInfo>,
  options: ResolvedLockOptionsData,
  fileBase: string,
): PreparedBackend {
  return preparePollingBackend(info, options, `${fileBase}.poll.lock`);
}

export async function prepareFlockBackend(
  info: Readonly<LockInfo>,
  options: ResolvedLockOptionsData,
  fileBase: string,
  dependencies: FileBackendDependencies = { loadFsExt },
): Promise<PreparedBackend> {
  const flockFile = `${fileBase}.flock`;
  const fsExt = await dependencies.loadFsExt();
  if (!fsExt) {
    if (options.scope.flock === true) {
      throw new LockUnavailableError(
        info,
        "native flock is unavailable on this platform",
      );
    }
    return prepareSkippedBackend(
      Object.freeze({
        scope: "flock",
        type: "skipped",
        file: flockFile,
        fallback: "native-flock-unavailable",
      } satisfies LockBackendInfo),
    );
  }

  return createFlockBackend(fsExt, info, options, flockFile);
}
