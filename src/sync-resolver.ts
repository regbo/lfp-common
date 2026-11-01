import { readFileSync } from 'node:fs';
import type { ResolvedPyfigOptions } from './config.js';
import {
  ensureEnvironment,
  ensurePython,
  ensureUv,
  ensureVirtualEnvironment,
} from './provision.js';

interface SyncResolutionRequest {
  target: 'python' | 'venv' | 'environment' | 'uv' | 'uv-pip';
  options: ResolvedPyfigOptions;
}

async function main(): Promise<void> {
  const request = JSON.parse(readFileSync(0, 'utf8')) as SyncResolutionRequest;
  const result = request.target === 'python'
    ? await ensurePython(request.options)
    : request.target === 'venv'
      ? await ensureVirtualEnvironment(request.options)
    : request.target === 'uv'
      ? await ensureUv(request.options)
      : request.target === 'uv-pip'
        ? {
            uv: await ensureUv(request.options),
            python: await ensureVirtualEnvironment(request.options),
          }
        : await ensureEnvironment(request.options);
  process.stdout.write(JSON.stringify(result));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message);
  process.exitCode = 1;
});
