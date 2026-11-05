import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  prepareFlockBackend,
  preparePollBackend,
} from "../src/backends/file.js";
import { prepareWorkerBackend } from "../src/backends/worker.js";
import {
  LockTimeoutError,
  LockUnavailableError,
  memoize,
  withLock,
} from "../src/index.js";
import { lockOptionsSchema } from "../src/schemas.js";
import { resolveLockScope, shouldSkipPoll } from "../src/scope.js";
import type { LockInfo } from "../src/types.js";

const defaultScope = {
  memory: true,
  worker: "auto",
  flock: "auto",
  poll: "auto",
} as const;
const memoryOnly = {
  memory: true,
  worker: false,
  flock: false,
  poll: false,
} as const;

test("exposes only the supported runtime API", async () => {
  const api = await import("../src/index.js");
  expect(Object.keys(api).sort()).toEqual([
    "LockAbortedError",
    "LockTimeoutError",
    "LockUnavailableError",
    "lockAutoScopeSchema",
    "lockBackendScopeSchema",
    "lockBackendScopes",
    "lockOptionsSchema",
    "lockScopeSchema",
    "lockTimeoutSchema",
    "memoize",
    "withLock",
  ]);
});

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
  test("normalizes scope defaults and optional timeout shorthand", () => {
    expect(lockOptionsSchema.parse({}).scope).toEqual(defaultScope);
    expect(lockOptionsSchema.parse({ scope: {} }).scope).toEqual(defaultScope);
    expect(
      lockOptionsSchema.parse({
        scope: {
          memory: undefined,
          worker: undefined,
          flock: undefined,
          poll: undefined,
        },
      }).scope,
    ).toEqual(defaultScope);
    expect(
      lockOptionsSchema.parse({
        scope: { memory: false, worker: true, flock: false },
      }).scope,
    ).toEqual({ memory: false, worker: true, flock: false, poll: "auto" });
    expect(() =>
      lockOptionsSchema.parse({ scope: { memory: "auto" } }),
    ).toThrow();
    expect(() =>
      lockOptionsSchema.parse({ scope: { unknown: true } }),
    ).toThrow();

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

  test("uses required and automatic layers by default", async () => {
    const lockDirectory = await mkdtemp(join(tmpdir(), "loqkit-test-"));
    let active = 0;
    let peak = 0;

    try {
      const run = () =>
        withLock(
          { resource: "layered" },
          async ({ lock, state }) => {
            expect(state).toBe("executed");
            expect(lock.scope.memory).toBe(true);
            expect([true, "skipped"]).toContain(lock.scope.worker);
            expect([true, "skipped"]).toContain(lock.scope.flock);
            expect([true, "skipped"]).toContain(lock.scope.poll);
            expect(lock.type).toBe("composite");
            expect(lock.backends.map(({ scope }) => scope)).toEqual([
              "memory",
              "worker",
              "flock",
              "poll",
            ]);
            expect(["worker", "skipped"]).toContain(lock.backends[1]!.type);
            expect(["flock", "skipped"]).toContain(lock.backends[2]!.type);
            expect(["poll", "skipped"]).toContain(lock.backends[3]!.type);

            active += 1;
            peak = Math.max(peak, active);
            await delay(5);
            active -= 1;
          },
          {
            key: "layered",
            lockDirectory,
          },
        );

      const results = await Promise.all([run(), run(), run()]);
      expect(peak).toBe(1);
      expect(
        results.every(({ context }) => context.state === "executed"),
      ).toBe(true);
    } finally {
      await rm(lockDirectory, { force: true, recursive: true });
    }
  });

  test("supports an explicitly memory-only lock", async () => {
    let checks = 0;
    let actionContext: object | undefined;
    const result = await withLock(
      { resource: "conditional" },
      (context) => {
        actionContext = context;
        const { lock } = context;
        expect(lock.backends).toEqual([{ scope: "memory", type: "memory" }]);
        return "done";
      },
      () => {
        checks += 1;
        return true;
      },
      { scope: memoryOnly },
    );

    expect(result.value).toBe("done");
    expect(result.context).toMatchObject({
      state: "executed",
    });
    expect("acquired" in result.context).toBe(false);
    expect(actionContext).toBe(result.context);
    expect(checks).toBe(2);
  });

  test("supports scope overrides in canonical order", async () => {
    const lockDirectory = await mkdtemp(join(tmpdir(), "loqkit-scope-test-"));

    try {
      const result = await withLock(
        { resource: "selected-scopes" },
        ({ lock }) => lock.backends.map(({ scope }) => scope),
        {
          lockDirectory,
          scope: { ...defaultScope, worker: false, flock: false },
        },
      );

      expect(result.value).toEqual(["memory", "poll"]);
      expect(result.context.lock.scope).toEqual({
        memory: true,
        worker: false,
        flock: false,
        poll: true,
      });
    } finally {
      await rm(lockDirectory, { force: true, recursive: true });
    }
  });

  test("accepts the predicate as an options field", async () => {
    let checks = 0;
    let actions = 0;
    const states: string[] = [];

    const result = await withLock(
      { resource: "options-predicate" },
      () => {
        actions += 1;
        return "done";
      },
      {
        scope: memoryOnly,
        predicate: ({ resource, state }) => {
          checks += 1;
          states.push(state);
          return resource === "options-predicate";
        },
      },
    );

    expect(result.value).toBe("done");
    expect(result.context.state).toBe("executed");
    expect(checks).toBe(2);
    expect(actions).toBe(1);
    expect(states).toEqual(["predicate-before", "predicate-after"]);
  });

  test("runs onCheckFailed after releasing an acquired lock", async () => {
    const key = "post-check-failure";
    let actions = 0;
    let nestedActions = 0;
    let observedState: string | undefined;

    const result = await withLock(
      { resource: key },
      () => {
        actions += 1;
      },
      {
        key,
        scope: memoryOnly,
        predicate: ({ state }) => state === "predicate-before",
        onCheckFailed: async ({ resource, state }) => {
          observedState = state;
          expect(resource).toBe(key);

          await withLock(
            { resource },
            () => {
              nestedActions += 1;
            },
            { key, scope: memoryOnly, timeout: 0 },
          );
        },
      },
    );

    expect(result.value).toBeUndefined();
    expect(result.context).toMatchObject({
      state: "predicate-after",
    });
    expect("acquired" in result.context).toBe(false);
    expect(observedState).toBe("predicate-after");
    expect(actions).toBe(0);
    expect(nestedActions).toBe(1);
  });

  test("reports a failed pre-acquisition check without taking the lock", async () => {
    let observedState: string | undefined;

    const result = await withLock(
      { resource: "pre-check-failure" },
      () => {
        throw new Error("action should not run");
      },
      {
        scope: memoryOnly,
        predicate: ({ state }) => state === "predicate-after",
        onCheckFailed: ({ state }) => {
          observedState = state;
        },
      },
    );

    expect(result.value).toBeUndefined();
    expect(result.context).toMatchObject({
      state: "predicate-before",
    });
    expect("acquired" in result.context).toBe(false);
    expect(observedState).toBe("predicate-before");
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
          lockDirectory,
          scope: { ...defaultScope, flock: false },
          timeout: 100,
        },
      );

      expect(result.value).toBe("finished");
      expect(result.context.state).toBe("executed");
    } finally {
      await rm(lockDirectory, { force: true, recursive: true });
    }
  });

  test("returns a timeout context when configured and throws by default", async () => {
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
      { key, scope: memoryOnly },
    );
    await entered;

    const attempt = await withLock(
      { resource: key },
      () => "contender",
      {
        key,
        scope: memoryOnly,
        timeout: { ms: 0, error: false },
      },
    );
    expect(attempt.value).toBeUndefined();
    expect(attempt.context).toMatchObject({
      resource: key,
      state: "timeout",
    });
    expect("acquired" in attempt.context).toBe(false);
    expect(attempt.context.lock.waitedMs).toBeGreaterThanOrEqual(0);

    await expect(
      withLock(
        { resource: key },
        () => "contender",
        { key, scope: memoryOnly, timeout: 0 },
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

  test("supports disabling every lock layer", async () => {
    const result = await withLock(
      { resource: "unlocked" },
      ({ lock }) => lock.backends.length,
      {
        scope: {
          memory: false,
          worker: false,
          flock: false,
          poll: false,
        },
      },
    );

    expect(result.value).toBe(0);
    expect(result.context.lock.type).toBe("skipped");
    expect(result.context.lock.backends).toEqual([]);
  });

  test("reports automatic scope outcomes as true or skipped", () => {
    expect(
      resolveLockScope(defaultScope, [
        { scope: "memory", type: "memory" },
        {
          scope: "worker",
          type: "skipped",
          fallback: "worker-locks-unavailable",
        },
        { scope: "flock", type: "flock" },
        { scope: "poll", type: "skipped" },
      ]),
    ).toEqual({
      memory: true,
      worker: "skipped",
      flock: true,
      poll: "skipped",
    });
    expect(
      shouldSkipPoll(defaultScope, [{ scope: "flock", type: "flock" }]),
    ).toBe(true);
    expect(
      shouldSkipPoll(
        { ...defaultScope, poll: true },
        [{ scope: "flock", type: "flock" }],
      ),
    ).toBe(false);
  });

  test("required poll fails fast on contention after flock acquisition", async () => {
    const root = await mkdtemp(join(tmpdir(), "loqkit-poll-test-"));
    const options = lockOptionsSchema.parse({
      lockDirectory: root,
      scope: {
        memory: false,
        worker: false,
        flock: true,
        poll: true,
      },
      timeout: 250,
    });
    const info = {
      id: "required-poll",
      name: "required-poll",
      namespace: "loqkit-test",
      scope: {
        memory: false,
        worker: false,
        flock: true,
        poll: true,
      },
      type: "composite",
      backends: [
        { scope: "flock", type: "flock" },
        { scope: "poll", type: "poll" },
      ],
      waitedMs: 0,
    } as const satisfies LockInfo;
    const fileBase = join(root, "required-poll");
    let enterHolder!: () => void;
    let releaseHolder!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterHolder = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    try {
      const holderBackend = preparePollBackend(info, options, fileBase);
      const holder = holderBackend.run(async () => {
        enterHolder();
        await release;
      });
      await entered;

      const contender = preparePollBackend(info, options, fileBase);
      await expect(
        contender.run(async () => undefined, [
          { scope: "flock", type: "flock" },
        ]),
      ).rejects.toBeInstanceOf(LockUnavailableError);

      releaseHolder();
      await holder;
    } finally {
      releaseHolder?.();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("auto bypasses native flock when it is unavailable or fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "loqkit-fallback-test-"));
    const options = lockOptionsSchema.parse({
      lockDirectory: root,
      scope: {
        memory: false,
        worker: false,
        flock: "auto",
        poll: false,
      },
    });
    const info = {
      id: "native-fallback",
      name: "native-fallback",
      namespace: "loqkit-test",
      scope: {
        memory: false,
        worker: false,
        flock: true,
        poll: false,
      },
      type: "flock",
      backends: [{ scope: "flock", type: "flock" }],
      waitedMs: 0,
    } as const satisfies LockInfo;

    try {
      const unavailable = await prepareFlockBackend(
        info,
        options,
        join(root, "native-unavailable"),
        { loadFsExt: async () => undefined },
      );
      expect(await unavailable.run(async (details) => details)).toMatchObject({
        scope: "flock",
        type: "skipped",
        fallback: "native-flock-unavailable",
      });

      const failed = await prepareFlockBackend(
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

      expect(await failed.run(async (details) => details)).toMatchObject({
        scope: "flock",
        type: "skipped",
        fallback: "native-flock-failed",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("explicit flock throws when native locking is unavailable or fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "loqkit-flock-test-"));
    const options = lockOptionsSchema.parse({
      lockDirectory: root,
      scope: {
        memory: false,
        worker: false,
        flock: true,
        poll: false,
      },
    });
    const info = {
      id: "required-native",
      name: "required-native",
      namespace: "loqkit-test",
      scope: {
        memory: false,
        worker: false,
        flock: true,
        poll: false,
      },
      type: "flock",
      backends: [{ scope: "flock", type: "flock" }],
      waitedMs: 0,
    } as const satisfies LockInfo;

    try {
      await expect(
        prepareFlockBackend(info, options, join(root, "unavailable"), {
          loadFsExt: async () => undefined,
        }),
      ).rejects.toBeInstanceOf(LockUnavailableError);

      const backend = await prepareFlockBackend(
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
        lockDirectory: root,
        scope: options.scope,
        timeout: 0,
      });
      const busyBackend = await prepareFlockBackend(
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

  test("worker auto bypasses an unavailable API while true is strict", async () => {
    const autoOptions = lockOptionsSchema.parse({
      scope: {
        memory: false,
        worker: "auto",
        flock: false,
        poll: false,
      },
    });
    const autoInfo = {
      id: "worker-auto",
      name: "worker-auto",
      namespace: "loqkit-test",
      scope: {
        memory: false,
        worker: true,
        flock: false,
        poll: false,
      },
      type: "worker",
      backends: [{ scope: "worker", type: "worker" }],
      waitedMs: 0,
    } as const satisfies LockInfo;
    const unavailable = { getWorkerLocks: () => undefined };
    const autoBackend = prepareWorkerBackend(
      autoInfo,
      autoOptions,
      unavailable,
    );

    expect(await autoBackend.run(async (details) => details)).toMatchObject({
      scope: "worker",
      type: "skipped",
      fallback: "worker-locks-unavailable",
    });

    const strictOptions = lockOptionsSchema.parse({
      scope: { ...autoOptions.scope, worker: true },
    });
    expect(() =>
      prepareWorkerBackend(autoInfo, strictOptions, unavailable),
    ).toThrow(LockUnavailableError);
  });
});
