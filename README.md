# loqkit

Typed memoization and layered locking for JavaScript runtimes.

## Locking

```ts
import { withLock } from "loqkit";

await withLock(
  { resource: "cache" },
  async ({ resource, lock }) => {
    console.log(`locked ${resource} with ${lock.backends.length} layers`);
  },
  async ({ resource }) => resource === "cache",
  { key: "cache-refresh" },
);
```

By default, `withLock` acquires memory, worker-thread, and file locks for the same key. The optional predicate runs once before waiting and again after all three layers are held. The action runs only when both checks pass.

Use a narrower scope only when you deliberately need one boundary:

```ts
await withLock(context, action, { scope: "memory" });
await withLock(context, action, { scope: "worker" });
await withLock(context, action, { scope: "file" });
```

## Memoization

`memoize` turns a zero-argument factory into a getter that computes once and reuses its successful result. A synchronous factory stays synchronous. An asynchronous or thenable factory returns a native promise, and concurrent callers share the same in-flight work.

```ts
import { memoize } from "loqkit";

const getConfig = memoize(() => ({ region: "us-east-1" }));
const config = getConfig();

const getCatalog = memoize(async () => {
  const response = await fetch("https://example.com/catalog.json");
  return response.json();
});

const catalog = await getCatalog();
```

Successful results remain cached for the lifetime of the memoized getter. Thrown errors and rejected promises are not cached, so the next call retries. There is no TTL or expiration behavior.

```mermaid
flowchart TD
    call["Call memoized getter"] --> cached{"Successful result cached?"}
    cached -- "Yes" --> reuse["Return cached value or promise"]
    cached -- "No" --> factory["Run factory"]
    factory --> kind{"Thenable result?"}
    kind -- "No" --> storeValue["Cache and return value"]
    kind -- "Yes" --> storePromise["Cache and return in-flight promise"]
    storePromise --> outcome{"Promise outcome"}
    outcome -- "Resolved" --> keep["Keep successful promise"]
    outcome -- "Rejected" --> evict["Evict so the next call retries"]
```

## How locking works

`withLock` is a key-scoped lock. Calls with the same namespace and key run one at a time; calls with different keys can run concurrently. If no key is supplied, loqkit hashes the context into a stable key.

The default `scope: "all"` acquires these layers in order and releases them in reverse:

1. An in-memory [`async-mutex`](https://github.com/DirtyHairy/async-mutex) lock serializes callers in the current JavaScript isolate.
2. Node's worker lock manager coordinates worker threads when the runtime provides it. In the default layered mode, the file layer still preserves coordination when that API is unavailable; an explicit worker-only lock reports `LockUnavailableError` instead.
3. A file lock coordinates processes on the same host. On macOS and Linux, `fileStrategy: "auto"` prefers the optional native [`fs-ext`](https://github.com/baudehlo/node-fs-ext) `flock` implementation. If native locking is unavailable or acquisition fails—for example, because a network filesystem does not support `flock`—loqkit transparently falls back to [`proper-lockfile`](https://github.com/moxystudio/node-proper-lockfile) polling.

Set `fileStrategy: "flock"` to explicitly prefer native `flock` with the same safe fallback, or `fileStrategy: "poll"` to skip native locking and use the portable polling implementation directly. A contention response stays on `flock`; switching protocols while another caller holds a native lock would break exclusivity. Filesystems that incorrectly report a successful native lock cannot be detected, so configure `"poll"` for a network mount known to have unreliable `flock` semantics. `lockDirectory` or `LOQKIT_LOCK_DIR` controls where file locks are stored.

```mermaid
flowchart TD
    call["Call withLock"] --> options["Validate options and choose a key"]
    options --> checking["Create context with checking state"]
    checking --> before{"Predicate passes before waiting?"}
    before -- "No" --> skippedBefore["Return predicate-before"]
    before -- "Yes or absent" --> memory["Acquire memory lock"]
    memory --> worker["Acquire worker-thread lock"]
    worker --> file["Acquire native flock or polling file lock"]
    file --> acquired["Create context with all layers acquired"]
    acquired --> after{"Predicate still passes?"}
    after -- "No" --> skippedAfter["Return predicate-after"]
    after -- "Yes or absent" --> action["Run the action exclusively"]
    action --> release["Release file, worker, then memory"]
    release --> result["Return the executed value"]
```

The second predicate check matters when another caller changes the underlying state while this caller is waiting:

```mermaid
sequenceDiagram
    participant A as Caller A
    participant B as Caller B
    participant L as Layered lock for one key

    A->>L: Acquire memory, worker, file
    L-->>A: Granted
    B->>B: Check predicate
    B->>L: Acquire same layers
    Note over B,L: Caller B waits
    A->>A: Run action
    A-->>L: Release all layers
    L-->>B: Granted
    B->>B: Check predicate again
    B->>B: Run action if still needed
    B-->>L: Release all layers
```

The default file directory is local to the host. Containers coordinate only when they share the configured lock directory, and separate hosts still need a shared lock service or database-backed lock.
