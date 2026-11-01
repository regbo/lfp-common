import { expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { withLock } from "../src/index.js";

test("serializes work and checks the predicate twice", async () => {
  let active = 0;
  let peak = 0;
  let checks = 0;

  const run = () =>
    withLock(
      { resource: "shared" },
      async ({ lock }) => {
        expect(lock.state).toBe("acquired");
        active += 1;
        peak = Math.max(peak, active);
        await delay(5);
        active -= 1;
      },
      () => {
        checks += 1;
        return true;
      },
      { key: "shared" },
    );

  await Promise.all([run(), run()]);
  expect(peak).toBe(1);
  expect(checks).toBe(4);
});
