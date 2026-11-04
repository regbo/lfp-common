import { createRequire } from "node:module";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const outdir = join(root, "release", "cjs");

await rm(outdir, { force: true, recursive: true });
await mkdir(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [
    join(root, "src", "index.ts"),
    join(root, "src", "_generated", "metadata.ts"),
  ],
  external: ["fs-ext"],
  format: "cjs",
  outdir,
  packages: "bundle",
  target: "node",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("Could not build the CommonJS distribution");
}

await writeFile(
  join(outdir, "package.json"),
  `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`,
  "utf8",
);

// Load the generated entry now so an ESM-only transitive dependency cannot
// reach a consumer release unnoticed.
const api = createRequire(import.meta.url)(join(outdir, "index.js")) as {
  memoize?: unknown;
  withLock?: unknown;
};
if (typeof api.memoize !== "function" || typeof api.withLock !== "function") {
  throw new Error("CommonJS distribution does not expose the public API");
}
