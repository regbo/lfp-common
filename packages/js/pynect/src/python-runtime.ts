import type { ChildProcess, SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pyfig } from 'pyfig';
import type { PynectProject } from './config.js';
import { resolvePythonPackage } from './python-package.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

/** Run the bundled Python adapter inside the configured uv project. */
export async function spawnWorker(
  project: PynectProject,
  pythonArguments: readonly string[],
  options: SpawnOptions = {},
): Promise<ChildProcess> {
  const python = typeof project.python === 'string'
    ? { python: project.python }
    : project.python;
  const environment = await pyfig({ ...python, cwd: project.root });
  const pythonPath = await environment.python.resolve();
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
  return child;
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
