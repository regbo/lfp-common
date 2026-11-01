import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureUv } from '../src/index.ts';

const requiresUv = process.argv[2];
const expectedVersion = process.argv[3];
if (!requiresUv || !expectedVersion) {
  throw new TypeError(
    'Usage: bun run scripts/smoke-uv-resolution.ts <requires-uv> <expected-version>',
  );
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'pyfig-uv-resolution-'));
try {
  const cacheDir = path.join(temporary, 'cache');
  const emptyPath = path.join(temporary, 'empty-path');
  await mkdir(emptyPath, { recursive: true });
  const env = {
    ...process.env,
    PATH: emptyPath,
    PYFIG_UV: path.join(temporary, 'missing-uv'),
  };
  const options = { cacheDir, env, requiresUv };

  const coldStarted = performance.now();
  const [first, concurrent] = await Promise.all([ensureUv(options), ensureUv(options)]);
  const coldMs = performance.now() - coldStarted;
  if (first.version !== expectedVersion || concurrent.executable !== first.executable) {
    throw new Error(
      `Expected concurrent resolution to select uv ${expectedVersion}, received ` +
      `${first.version} and ${concurrent.version}.`,
    );
  }

  const validatedCacheStarted = performance.now();
  const validatedCache = await ensureUv(options);
  const validatedCacheMs = performance.now() - validatedCacheStarted;
  if (validatedCache.executable !== first.executable || validatedCache.version !== expectedVersion) {
    throw new Error('Validated resolution did not reuse the compatible cached uv executable.');
  }

  console.log(JSON.stringify({ coldMs, executable: first.executable, validatedCacheMs }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
