import type { ChildProcess, SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pyfig, type PythonContext } from 'pyfig';
import type { PynectProject } from './config.js';
import { resolvePythonPath } from './utils/pyfig.js';
import { resolvePythonPackage } from './utils/python-package.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export interface SpawnWorkerResult {
  readonly child: ChildProcess;
  readonly environment: PythonContext;
}

/** Run the bundled Python adapter inside the configured uv project. */
export async function spawnWorker(
  project: PynectProject,
  pythonArguments: readonly string[],
  options: SpawnOptions = {},
): Promise<SpawnWorkerResult> {
  const environment = await pyfig({
    cwd: project.root,
    debug: project.debug,
    ...(project.python ? { python: project.python } : {}),
    ...(project.uv ? { uv: project.uv } : {}),
  });
  const pythonPath = await resolvePythonPath(environment);
  const worker = resolvePythonPackage(moduleDirectory);
  const args = [
    'run',
    '--quiet',
    '--project', project.root,
    '--python', pythonPath,
    worker.editable ? '--with-editable' : '--with', worker.requirement,
    '--',
    'python',
    ...pythonArguments,
  ];
  const child = await environment.uv.spawn(...args, {
    cwd: project.root,
    windowsHide: true,
    ...options,
    env: { ...process.env, ...options.env },
  });
  return { child, environment };
}

export function waitForChild(child: ChildProcess, purpose: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${purpose} exited with ${signal ?? `code ${code ?? 'unknown'}`}.`));
    });
  });
}
