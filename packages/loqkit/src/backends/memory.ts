import { Mutex } from "async-mutex";
import type { ResolvedLockOptionsData } from "../schemas.js";
import type { LockBackendInfo, LockInfo } from "../types.js";
import { acquireWithLimits } from "../waiting.js";
import type { PreparedBackend } from "./types.js";

interface MutexEntry {
  readonly mutex: Mutex;
  users: number;
}

const mutexes = new Map<string, MutexEntry>();

function retainMutex(id: string): MutexEntry {
  let entry = mutexes.get(id);
  if (!entry) {
    entry = { mutex: new Mutex(), users: 0 };
    mutexes.set(id, entry);
  }
  entry.users += 1;
  return entry;
}

function releaseMutexReference(id: string, entry: MutexEntry): void {
  entry.users -= 1;
  deleteUnusedMutex(id, entry);
}

function deleteUnusedMutex(id: string, entry: MutexEntry): void {
  if (entry.users === 0 && !entry.mutex.isLocked()) {
    mutexes.delete(id);
  }
}

export function prepareMemoryBackend(
  info: Readonly<LockInfo>,
  options: ResolvedLockOptionsData,
  details: Readonly<LockBackendInfo> = {
    scope: "memory",
    type: "memory",
  },
): PreparedBackend {
  return {
    initial: details,
    async run<TResult>(
      callback: (details: Readonly<LockBackendInfo>) => Promise<TResult>,
    ): Promise<TResult> {
      const entry = retainMutex(info.id);
      const acquisition = entry.mutex.acquire();
      let release: (() => void) | undefined;

      try {
        release = await acquireWithLimits(
          acquisition,
          options.timeout?.ms,
          options.signal,
          info,
          (lateRelease) => {
            lateRelease();
            deleteUnusedMutex(info.id, entry);
          },
        );
        return await callback(details);
      } finally {
        release?.();
        releaseMutexReference(info.id, entry);
      }
    },
  };
}
