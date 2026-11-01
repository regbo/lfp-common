import { readFileSync } from 'node:fs';
import type { ResolvedPyfigOptions } from './config.js';
import { ensureEnvironment, ensureUv } from './provision.js';

interface SyncResolutionRequest {
  target: 'environment' | 'uv';
  options: ResolvedPyfigOptions;
}

async function main(): Promise<void> {
  const request = JSON.parse(readFileSync(0, 'utf8')) as SyncResolutionRequest;
  const result = request.target === 'uv'
    ? await ensureUv(request.options)
    : await ensureEnvironment(request.options);
  process.stdout.write(JSON.stringify(result));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message);
  process.exitCode = 1;
});
