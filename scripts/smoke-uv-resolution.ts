import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
  const metadataFile = path.join(cacheDir, 'metadata', 'uv-releases.json');
  const metadata = JSON.parse(await readFile(metadataFile, 'utf8')) as { fetchedAt?: unknown };
  if (typeof metadata.fetchedAt !== 'number' ||
      Date.now() - metadata.fetchedAt >= 24 * 60 * 60_000) {
    throw new Error('Cold resolution did not publish fresh uv release metadata.');
  }

  const offlineOptions = {
    ...options,
    env: {
      ...env,
      HTTP_PROXY: 'http://127.0.0.1:1',
      HTTPS_PROXY: 'http://127.0.0.1:1',
      http_proxy: 'http://127.0.0.1:1',
      https_proxy: 'http://127.0.0.1:1',
    },
  };
  const validatedCacheStarted = performance.now();
  const validatedCache = await ensureUv(offlineOptions);
  const validatedCacheMs = performance.now() - validatedCacheStarted;
  if (validatedCache.executable !== first.executable || validatedCache.version !== expectedVersion) {
    throw new Error('Validated resolution did not reuse the compatible cached uv executable.');
  }

  console.log(JSON.stringify({
    coldMs,
    executable: first.executable,
    metadataFile,
    validatedCacheMs,
  }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
