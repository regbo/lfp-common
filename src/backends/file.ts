import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import type { ResolvedLockOptions } from "../schemas.js";
import type { LockBackendInfo, LockInfo } from "../types.js";
import { throwIfAborted, waitForRetry } from "../waiting.js";
import type { PreparedBackend } from "./types.js";

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
  options: ResolvedLockOptions,
  file: string,
  fallback?: string,
): PreparedBackend {
  const target = `${file}.target`;
  const details = {
    scope: "file",
    type: "poll",
    file,
    ...(fallback ? { fallback } : {}),
  } as const satisfies LockBackendInfo;

  return {
    initial: details,
    async run<TResult>(
      callback: (details: Readonly<LockBackendInfo>) => Promise<TResult>,
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
          await waitForRetry(
            startedAt,
            options.timeoutMs,
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

function prepareFlockBackend(
  fsExt: FsExt,
  info: Readonly<LockInfo>,
  options: ResolvedLockOptions,
  file: string,
  pollingFallback?: PreparedBackend,
): PreparedBackend {
  const details = {
    scope: "file",
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
                options.timeoutMs,
                options.pollIntervalMs,
                options.signal,
                info,
              );
              continue;
            }

            // Never switch protocols for contention: a proper-lockfile lock
            // would not see the flock already held by another caller.
            if (pollingFallback) {
              await handle.close();
              return pollingFallback.run(callback);
            }
            throw error;
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

export async function prepareFileBackend(
  info: Readonly<LockInfo>,
  options: ResolvedLockOptions,
  fileBase: string,
  dependencies: FileBackendDependencies = { loadFsExt },
): Promise<PreparedBackend> {
  const pollFile = `${fileBase}.poll.lock`;
  const polling = preparePollingBackend(info, options, pollFile);

  if (options.fileStrategy === "poll") return polling;

  const fsExt = await dependencies.loadFsExt();
  if (!fsExt) {
    return preparePollingBackend(
      info,
      options,
      pollFile,
      "native-flock-unavailable",
    );
  }

  const flockFile = `${fileBase}.flock`;
  const fallback = preparePollingBackend(
    info,
    options,
    pollFile,
    "native-flock-failed",
  );
  return prepareFlockBackend(
    fsExt,
    info,
    options,
    flockFile,
    fallback,
  );
}
