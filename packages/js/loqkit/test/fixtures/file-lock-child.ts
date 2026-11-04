import { open, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { withLock } from "../../src/index.js";

const [lockDirectory, guardFile] = process.argv.slice(2);

if (!lockDirectory || !guardFile) {
  throw new Error("Expected lock and guard paths");
}

await withLock(
  { resource: "cross-process" },
  async () => {
    const guard = await open(guardFile, "wx");
    try {
      await delay(25);
    } finally {
      await guard.close();
      await rm(guardFile, { force: true });
    }
  },
  {
    key: "cross-process",
    lockDirectory,
    namespace: "loqkit-process-test",
    pollIntervalMs: 5,
    scope: {
      memory: false,
      worker: false,
      flock: false,
      poll: true,
    },
    timeout: 5_000,
  },
);
