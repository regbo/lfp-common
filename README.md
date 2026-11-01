# loqkit

Small typed locking primitives for JavaScript runtimes.

```ts
import { withLock } from "loqkit";

await withLock(
  { resource: "cache" },
  async ({ resource, lock }) => {
    console.log(`locked ${resource} with ${lock.type}`);
  },
  async ({ resource }) => resource === "cache",
  { key: "cache-refresh" },
);
```

The optional predicate runs once before waiting and again after acquisition. The action runs only when both checks pass.
