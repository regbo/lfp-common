import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { prepareFileBackend } from "../src/backends/file.js";
import {
  LockTimeoutError,
  LockUnavailableError,
  memoize,
  withLock,
} from "../src/index.js";
import { lockOptionsSchema } from "../src/schemas.js";
import type { LockInfo } from "../src/types.js";

describe("memoize", () => {
  test("memoizes synchronous results, including undefined", () => {
    let calls = 0;
    const getValue = memoize(() => {
      calls += 1;
      return undefined;
    });

    expect(getValue()).toBeUndefined();
    expect(getValue()).toBeUndefined();
    expect(calls).toBe(1);
  });

  test("shares an in-flight asynchronous result", async () => {
    let calls = 0;
    let resolve!: (value: string) => void;
    const getValue = memoize(() => {
      calls += 1;
      return new Promise<string>((complete) => {
        resolve = complete;
      });
    });

    const first = getValue();
    const second = getValue();
    expect(second).toBe(first);
    expect(calls).toBe(1);

    resolve("ready");
    expect(await first).toBe("ready");
    expect(getValue()).toBe(first);
  });

  test("retries synchronous and asynchronous failures", async () => {
    let syncCalls = 0;
    const getSyncValue = memoize(() => {
      syncCalls += 1;
      throw new Error("sync failure");
    });
    expect(getSyncValue).toThrow("sync failure");
    expect(getSyncValue).toThrow("sync failure");
    expect(syncCalls).toBe(2);

    let asyncCalls = 0;
    const getAsyncValue = memoize(async () => {
      asyncCalls += 1;
      if (asyncCalls === 1) throw new Error("async failure");
      return "recovered";
    });
    await expect(getAsyncValue()).rejects.toThrow("async failure");
    expect(await getAsyncValue()).toBe("recovered");
    expect(asyncCalls).toBe(2);
  });
});

describe("withLock", () => {
  test("normalizes scope and optional timeout shorthand", () => {
    expect(lockOptionsSchema.parse({}).scope).toEqual([
      "memory",
      "worker",
      "file",
    ]);
    expect(lockOptionsSchema.parse({ scope: "memory" }).scope).toEqual([
      "memory",
    ]);
    expect(
      lockOptionsSchema.parse({ scope: ["file", "memory"] }).scope,
    ).toEqual(["memory", "file"]);
    expect(() => lockOptionsSchema.parse({ scope: [] })).toThrow();
    expect(() =>
      lockOptionsSchema.parse({ scope: ["memory", "memory"] }),
    ).toThrow();
    expect(() => lockOptionsSchema.parse({ scope: "all" })).toThrow();

    expect(lockOptionsSchema.parse({}).timeout).toBeUndefined();
    expect(lockOptionsSchema.parse({ timeout: 25 }).timeout).toEqual({
      ms: 25,
      error: true,
    });
    expect(lockOptionsSchema.parse({ timeout: { ms: 25 } }).timeout).toEqual({
      ms: 25,
      error: true,
    });
    expect(
      lockOptionsSchema.parse({ timeout: { ms: 0, error: false } }).timeout,
    ).toEqual({ ms: 0, error: false });
  });

  test("acquires memory, worker, and file layers by default", async () => {
    const lockDirectory = await mkdtemp(join(tmpdir(), "loqkit-test-"));
    let active = 0;
    let peak = 0;

    try {
      const run = () =>
        withLock(
          { resource: "layered" },
          async ({ acquired, lock }) => {
            expect(acquired).toBe(true);
            expect(lock.scope).toEqual(["memory", "worker", "file"]);
            expect(lock.type).toBe("composite");
            expect(lock.backends.map(({ scope }) => scope)).toEqual([
              "memory",
              "worker",
              "file",
            ]);
            expect(lock.backends[2]?.type).toBe("poll");

            active += 1;
            peak = Math.max(peak, active);
            await delay(5);
            active -= 1;
          },
          {
            key: "layered",
            fileStrategy: "poll",
            lockDirectory,
          },
        );

      const results = await Promise.all([run(), run(), run()]);
      expect(peak).toBe(1);
      expect(results.every(({ stats }) => stats.outcome === "executed")).toBe(
        true,
      );
    } finally {
      await rm(lockDirectory, { force: true, recursive: true });
    }
  });

  test("supports an explicitly memory-only lock", async () => {
    let checks = 0;
    const result = await withLock(
      { resource: "conditional" },
      ({ lock }) => {
        expect(lock.backends).toEqual([{ scope: "memory", type: "memory" }]);
        return "done";
      },
      () => {
        checks += 1;
        return true;
      },
      { scope: "memory" },
    );

    expect(result.value).toBe("done");
    expect(result.stats).toMatchObject({
      acquired: true,
      executed: true,
      outcome: "executed",
      timedOut: false,
    });
    expect(checks).toBe(2);
  });

  test("supports multiple selected scopes in canonical order", async () => {
    const lockDirectory = await mkdtemp(join(tmpdir(), "loqkit-scope-test-"));

    try {
      const result = await withLock(
        { resource: "selected-scopes" },
        ({ lock }) => lock.backends.map(({ scope }) => scope),
        {
          fileStrategy: "poll",
          lockDirectory,
          scope: ["file", "memory"],
        },
      );

      expect(result.value).toEqual(["memory", "file"]);
      expect(result.stats.scope).toEqual(["memory", "file"]);
    } finally {
      await rm(lockDirectory, { force: true, recursive: true });
    }
  });

  test("accepts the predicate as an options field", async () => {
    let checks = 0;
    let actions = 0;
    const acquiredPhases: boolean[] = [];

    const result = await withLock(
      { resource: "options-predicate" },
      () => {
        actions += 1;
        return "done";
      },
      {
        scope: "memory",
        predicate: ({ acquired, resource }) => {
          checks += 1;
          acquiredPhases.push(acquired);
          return resource === "options-predicate";
        },
      },
    );

    expect(result.value).toBe("done");
    expect(result.stats.outcome).toBe("executed");
    expect(checks).toBe(2);
    expect(actions).toBe(1);
    expect(acquiredPhases).toEqual([false, true]);
  });

  test("runs onCheckFailed after releasing an acquired lock", async () => {
    const key = "post-check-failure";
    let actions = 0;
    let nestedActions = 0;
    let observedAcquired: boolean | undefined;

    const result = await withLock(
      { resource: key },
      () => {
        actions += 1;
      },
      {
        key,
        scope: "memory",
        predicate: ({ acquired }) => !acquired,
        onCheckFailed: async ({ acquired, lock, resource }) => {
          observedAcquired = acquired;
          expect(resource).toBe(key);
          expect(lock.state).toBe("acquired");

          await withLock(
            { resource },
            () => {
              nestedActions += 1;
            },
            { key, scope: "memory", timeout: 0 },
          );
        },
      },
    );

    expect(result.value).toBeUndefined();
    expect(result.stats).toMatchObject({
      acquired: true,
      executed: false,
      outcome: "predicate-after",
      timedOut: false,
    });
    expect(observedAcquired).toBe(true);
    expect(actions).toBe(0);
    expect(nestedActions).toBe(1);
  });

  test("reports a failed pre-acquisition check without taking the lock", async () => {
    let observedState: string | undefined;
    let observedAcquired: boolean | undefined;

    const result = await withLock(
      { resource: "pre-check-failure" },
      () => {
        throw new Error("action should not run");
      },
      {
        scope: "memory",
        predicate: ({ acquired }) => acquired,
        onCheckFailed: ({ acquired, lock }) => {
          observedAcquired = acquired;
          observedState = lock.state;
        },
      },
    );

    expect(result.value).toBeUndefined();
    expect(result.stats).toMatchObject({
      acquired: false,
      executed: false,
      outcome: "predicate-before",
      timedOut: false,
    });
    expect(observedAcquired).toBe(false);
    expect(observedState).toBe("checking");
  });

  test("applies timeout only while acquiring the layered lock", async () => {
    const lockDirectory = await mkdtemp(join(tmpdir(), "loqkit-action-test-"));

    try {
      const result = await withLock(
        { resource: "long-action" },
        async () => {
          await delay(150);
          return "finished";
        },
        {
          key: "long-action",
          fileStrategy: "poll",
          lockDirectory,
          timeout: 100,
        },
      );

      expect(result.value).toBe("finished");
      expect(result.stats.outcome).toBe("executed");
    } finally {
      await rm(lockDirectory, { force: true, recursive: true });
    }
  });

  test("returns timeout stats when configured and throws by default", async () => {
    const key = "immediate-timeout";
    let signalEntered!: () => void;
    let releaseHolder!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = withLock(
      { resource: key },
      async () => {
        signalEntered();
        await release;
        return "holder";
      },
      { key, scope: "memory" },
    );
    await entered;

    const attempt = await withLock(
      { resource: key },
      () => "contender",
      {
        key,
        scope: "memory",
        timeout: { ms: 0, error: false },
      },
    );
    expect(attempt.value).toBeUndefined();
    expect(attempt.stats).toMatchObject({
      acquired: false,
      executed: false,
      outcome: "timeout",
      state: "waiting",
      timedOut: true,
    });

    await expect(
      withLock(
        { resource: key },
        () => "contender",
        { key, scope: "memory", timeout: 0 },
      ),
    ).rejects.toBeInstanceOf(LockTimeoutError);

    releaseHolder();
    expect((await holder).value).toBe("holder");
  });

  test("serializes file-scoped work across processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "loqkit-process-test-"));
    const fixture = join(import.meta.dir, "fixtures", "file-lock-child.ts");
    const guardFile = join(root, "exclusive.guard");
    const lockDirectory = join(root, "locks");

    try {
      const children = Array.from({ length: 3 }, () =>
        Bun.spawn([process.execPath, fixture, lockDirectory, guardFile], {
          stderr: "pipe",
          stdout: "pipe",
        }),
      );
      const results = await Promise.all(
        children.map(async (child) => ({
          code: await child.exited,
          error: await new Response(child.stderr).text(),
        })),
      );

      expect(results).toEqual([
        { code: 0, error: "" },
        { code: 0, error: "" },
        { code: 0, error: "" },
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("auto falls back to proper-lockfile when native flock acquisition fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "loqkit-fallback-test-"));
    const options = lockOptionsSchema.parse({
      fileStrategy: "auto",
      lockDirectory: root,
      scope: ["file"],
    });
    const info = {
      id: "native-fallback",
      name: "native-fallback",
      namespace: "loqkit-test",
      scope: ["file"],
      type: "flock",
      backends: [{ scope: "file", type: "flock" }],
      state: "checking",
      strategy: "auto",
      waitedMs: 0,
    } as const satisfies LockInfo;

    try {
      const backend = await prepareFileBackend(
        info,
        options,
        join(root, "native-fallback"),
        {
          loadFsExt: async () => ({
            flock(_fileDescriptor, _flags, callback) {
              callback(
                Object.assign(new Error("flock unsupported"), {
                  code: "ENOTSUP",
                }),
              );
            },
          }),
        },
      );

      const details = await backend.run(async (acquired) => acquired);
      expect(details).toMatchObject({
        scope: "file",
        type: "poll",
        fallback: "native-flock-failed",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("explicit flock throws when native locking is unavailable or fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "loqkit-flock-test-"));
    const options = lockOptionsSchema.parse({
      fileStrategy: "flock",
      lockDirectory: root,
      scope: "file",
    });
    const info = {
      id: "required-native",
      name: "required-native",
      namespace: "loqkit-test",
      scope: ["file"],
      type: "flock",
      backends: [{ scope: "file", type: "flock" }],
      state: "checking",
      strategy: "flock",
      waitedMs: 0,
    } as const satisfies LockInfo;

    try {
      await expect(
        prepareFileBackend(info, options, join(root, "unavailable"), {
          loadFsExt: async () => undefined,
        }),
      ).rejects.toBeInstanceOf(LockUnavailableError);

      const backend = await prepareFileBackend(
        info,
        options,
        join(root, "failed"),
        {
          loadFsExt: async () => ({
            flock(_fileDescriptor, _flags, callback) {
              callback(
                Object.assign(new Error("flock unsupported"), {
                  code: "ENOTSUP",
                }),
              );
            },
          }),
        },
      );
      let actionRan = false;

      await expect(
        backend.run(async () => {
          actionRan = true;
        }),
      ).rejects.toMatchObject({ code: "LOQKIT_UNAVAILABLE" });
      expect(actionRan).toBe(false);

      let attempts = 0;
      const immediateOptions = lockOptionsSchema.parse({
        fileStrategy: "flock",
        lockDirectory: root,
        scope: "file",
        timeout: 0,
      });
      const busyBackend = await prepareFileBackend(
        info,
        immediateOptions,
        join(root, "busy"),
        {
          loadFsExt: async () => ({
            flock(_fileDescriptor, _flags, callback) {
              attempts += 1;
              callback(
                Object.assign(new Error("flock busy"), { code: "EAGAIN" }),
              );
            },
          }),
        },
      );
      await expect(busyBackend.run(async () => undefined)).rejects.toBeInstanceOf(
        LockTimeoutError,
      );
      expect(attempts).toBe(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
