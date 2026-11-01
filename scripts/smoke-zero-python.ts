import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureEnvironment } from '../src/index.ts';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'pyfig-zero-python-'));

try {
  const projectRoot = path.join(temporary, 'project');
  const cacheDir = path.join(temporary, 'cache');
  const emptyPath = path.join(temporary, 'empty-path');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(emptyPath, { recursive: true });

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'PATH' || key.toUpperCase() === 'PYTHONHOME' ||
        key.toUpperCase() === 'VIRTUAL_ENV') {
      delete env[key];
    }
  }
  env['PATH'] = emptyPath;
  env['PYFIG_UV'] = path.join(temporary, 'missing-uv');

  const environment = await ensureEnvironment({
    cacheDir,
    env,
    managedPython: '3.12',
    projectRoot,
    requireEmbedding: true,
    requireGil: true,
  });

  if (!environment.python.embedding || environment.python.gilDisabled) {
    throw new Error('Managed Python did not satisfy the embedding ABI requirements.');
  }
  if (path.resolve(environment.python.virtualEnvironment ?? '') !==
      path.join(projectRoot, 'node_modules', '.pyfig', 'venv')) {
    throw new Error('Managed Python was not installed into the repository virtual environment.');
  }
  console.log(`Zero-Python bootstrap verified: ${environment.python.executable}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
