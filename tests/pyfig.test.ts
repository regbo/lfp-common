import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import semver from 'semver';
import {
  DEFAULT_PYTHON_RANGE,
  DEFAULT_UV_RANGE,
  DEFAULT_UV_VERSION,
  createPyfig,
  ensureEnvironment,
  ensureUv,
  resolveProjectRoot,
  uvSpawn,
  uvSpawnSync,
} from '../src/index.ts';
import { resolveOptions } from '../src/config.ts';
import { pythonSatisfiesRequirements, type PythonInfo } from '../src/probes.ts';
import { buildUvCommand } from '../src/runners.ts';

let temporaryRoot = '';
let projectRoot = '';

beforeAll(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'pyfig-test-'));
  projectRoot = path.join(temporaryRoot, 'project');
  await mkdir(projectRoot, { recursive: true });
}, 30_000);

afterAll(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

describe('pyfig', () => {
  test('uses valid Python and uv compatibility ranges', () => {
    expect(semver.validRange(DEFAULT_PYTHON_RANGE)).not.toBeNull();
    expect(semver.satisfies('3.10.0', DEFAULT_PYTHON_RANGE)).toBe(true);
    expect(semver.satisfies('4.0.0', DEFAULT_PYTHON_RANGE)).toBe(false);
    expect(semver.satisfies('0.10.0', DEFAULT_UV_RANGE)).toBe(true);
    expect(semver.satisfies('0.9.9', DEFAULT_UV_RANGE)).toBe(false);
    expect(semver.satisfies(DEFAULT_UV_VERSION, DEFAULT_UV_RANGE)).toBe(true);
  });

  test('centralizes configuration and explicitly prefers system Python', () => {
    const env = { PYFIG_PYTHON_RANGE: '>=3.11.0 <3.12.0', INIT_CWD: projectRoot };
    const options = resolveOptions({
      pythonRange: '>=3.12.0 <3.13.0',
      env,
    });
    env.PYFIG_PYTHON_RANGE = '>=3.10.0';
    expect(options.pythonRange).toBe('>=3.12.0 <3.13.0');
    expect(options.projectRoot).toBe(projectRoot);
    expect(resolveOptions({ env: { PYFIG_AUTO_INSTALL: '0' } }).installPython).toBe(false);
  });

  test('rejects invalid setup configuration before probing', () => {
    expect(() => resolveOptions({ pythonRange: 'nope' })).toThrow('Invalid Python SemVer range');
    expect(() => resolveOptions({ uvVersion: '../uv' })).toThrow('Invalid exact uv version');
    expect(() => resolveOptions({ installTimeoutMs: 0 })).toThrow('positive integer');
    expect(() => resolveOptions({
      managedPython: '3.9',
      pythonRange: '>=3.10.0 <4.0.0',
    })).toThrow('cannot satisfy configured range');
  });

  test('does not infer ownership from package.json or pyproject.toml', async () => {
    const root = path.join(temporaryRoot, 'manifest-root');
    const nested = path.join(root, 'nested');
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(root, 'package.json'), '{}\n');
    await writeFile(path.join(root, 'pyproject.toml'), '[project]\nname="ignored"\n');
    expect(resolveProjectRoot(nested)).toBe(nested);
  });

  test('creates new environments only below node_modules', async () => {
    const root = path.join(temporaryRoot, 'managed-environment');
    await mkdir(root, { recursive: true });
    const environment = await ensureEnvironment({ projectRoot: root });
    expect(environment.managed).toBe(true);
    expect(path.resolve(environment.python.virtualEnvironment ?? '')).toBe(
      path.join(root, 'node_modules', '.pyfig', 'venv'),
    );
    expect(semver.satisfies(environment.python.version, DEFAULT_PYTHON_RANGE)).toBe(true);
  }, 60_000);

  test('reuses a compatible repository venv instead of creating another', async () => {
    const root = path.join(temporaryRoot, 'existing-environment');
    const existing = path.join(root, '.venv');
    await mkdir(root, { recursive: true });
    const uv = await ensureUv({ projectRoot: root });
    const created = spawnSync(uv.executable, [
      'venv', '--no-project', '--no-config', '--python-preference', 'system', existing,
    ], { encoding: 'utf8' });
    expect(created.status).toBe(0);
    const environment = await ensureEnvironment({ projectRoot: root });
    expect(environment.managed).toBe(false);
    expect(path.resolve(environment.python.virtualEnvironment ?? '')).toBe(existing);
    expect(await fileExists(path.join(root, 'node_modules', '.pyfig', 'venv'))).toBe(false);

    const prepared = await createPyfig({ projectRoot: root }).prepare(['idna==3.10']);
    expect(prepared.managed).toBe(false);
    expect(path.resolve(prepared.python.virtualEnvironment ?? '')).toBe(existing);
    expect(await fileExists(path.join(root, 'node_modules', '.pyfig', 'venv'))).toBe(false);
  }, 60_000);

  test('preserves an unusable external venv and creates the private fallback', async () => {
    const root = path.join(temporaryRoot, 'incompatible-environment');
    const external = path.join(root, '.venv');
    const sentinel = path.join(external, 'keep-me.txt');
    await mkdir(external, { recursive: true });
    await writeFile(sentinel, 'external data\n');
    const environment = await ensureEnvironment({ projectRoot: root });
    expect(environment.managed).toBe(true);
    expect(await readFile(sentinel, 'utf8')).toBe('external data\n');
    expect(path.resolve(environment.python.virtualEnvironment ?? '')).toBe(
      path.join(root, 'node_modules', '.pyfig', 'venv'),
    );
  }, 60_000);

  test('pins uv pip and run commands to the selected environment', () => {
    const virtualEnvironment = path.join(path.sep, 'managed', 'venv');
    const python = pythonFixture({
      executable: path.join(virtualEnvironment, 'bin', 'python'),
      virtualEnvironment,
    });
    const options = resolveOptions({ projectRoot, env: { PATH: '/bin' } });
    const pip = buildUvCommand(
      { executable: 'uv', version: '0.13.6' },
      ['pip', 'install', 'ruff'],
      options,
      python,
    );
    const run = buildUvCommand(
      { executable: 'uv', version: '0.13.6' },
      ['run', '--', 'python', '-V'],
      options,
      python,
    );
    expect(pip.args).toEqual(['pip', 'install', '--python', python.executable, 'ruff']);
    expect(run.args).toEqual([
      'run', '--no-project', '--python', python.executable, '--', 'python', '-V',
    ]);
    expect(pip.env['UV_PYTHON']).toBe(python.executable);
    expect(pip.env['VIRTUAL_ENV']).toBe(virtualEnvironment);
    expect(pip.env['UV_PYTHON_PREFERENCE']).toBe('system');
    expect(() => buildUvCommand(
      { executable: 'uv', version: '0.13.6' },
      ['pip', 'install', '--python', '/escape', 'ruff'],
      options,
      python,
    )).toThrow('cannot override');
  });

  test('runs the selected Python through uv asynchronously and synchronously', async () => {
    const root = path.join(temporaryRoot, 'spawn-environment');
    await mkdir(root, { recursive: true });
    const expected = (await ensureEnvironment({ projectRoot: root })).python.executable;
    const args = ['run', '--', 'python', '-c', 'import sys; print(sys.executable)'];
    const asynchronous = await capture(await uvSpawn(
      args,
      { stdio: ['ignore', 'pipe', 'pipe'] },
      { projectRoot: root },
    ));
    expect(path.resolve(asynchronous.stdout.trim())).toBe(path.resolve(expected));
    const synchronous = uvSpawnSync(args, { encoding: 'utf8' }, { projectRoot: root });
    expect(synchronous.status).toBe(0);
    expect(path.resolve(String(synchronous.stdout).trim())).toBe(path.resolve(expected));
  }, 60_000);

  test('leaves project inputs unchanged while installing runtime requirements', async () => {
    const root = path.join(temporaryRoot, 'runtime-dependencies');
    const pyproject = path.join(root, 'pyproject.toml');
    const requirements = path.join(root, 'requirements.txt');
    await mkdir(root, { recursive: true });
    await writeFile(
      pyproject,
      '[project]\nname="runtime-test"\nversion="0.0.0"\ndependencies=[]\n' +
      '[project.optional-dependencies]\nruntime=["idna==3.10"]\n',
    );
    await writeFile(requirements, 'do-not-edit==1\n');
    const beforeProject = await readFile(pyproject, 'utf8');
    const beforeRequirements = await readFile(requirements, 'utf8');
    const environment = await createPyfig({ projectRoot: root }).prepare(
      ['sniffio==1.3.1'],
      { extras: ['runtime'] },
    );
    expect(await readFile(pyproject, 'utf8')).toBe(beforeProject);
    expect(await readFile(requirements, 'utf8')).toBe(beforeRequirements);
    const result = uvSpawnSync(
      ['run', '--', 'python', '-c', 'import idna, sniffio; print(idna.__version__)'],
      { encoding: 'utf8' },
      { projectRoot: root },
    );
    expect(result.status).toBe(0);
    expect(String(result.stdout).trim()).toBe('3.10');
    expect(environment.python.virtualEnvironment).toBeTruthy();
  }, 60_000);

  test('validates native embedding requirements', () => {
    const python = pythonFixture({ embedding: null });
    const embeddingOptions = resolveOptions({ requireEmbedding: true, projectRoot });
    expect(pythonSatisfiesRequirements(python, embeddingOptions)).toBe(false);
    expect(pythonSatisfiesRequirements(
      { ...python, implementation: 'pypy' },
      embeddingOptions,
    )).toBe(false);
  });

  test('keeps the root API uv-centric', async () => {
    const api = await import('../src/index.ts');
    expect(Object.keys(api).sort()).toEqual([
      'DEFAULT_MANAGED_PYTHON',
      'DEFAULT_PYTHON_RANGE',
      'DEFAULT_UV_RANGE',
      'DEFAULT_UV_VERSION',
      'createPyfig',
      'ensureEnvironment',
      'ensureUv',
      'resolveProjectRoot',
      'uvSpawn',
      'uvSpawnSync',
    ]);
  });

  test('memoizes preparation without requirements', async () => {
    const root = path.join(temporaryRoot, 'memoized-environment');
    await mkdir(root, { recursive: true });
    const client = createPyfig({ projectRoot: root });
    const first = client.prepare();
    const second = client.prepare();
    expect(second).toBe(first);
    expect(await second).toBe(await first);
  }, 60_000);

  test('serializes provisioning across separate processes', async () => {
    const root = path.join(temporaryRoot, 'lock-test');
    await mkdir(root, { recursive: true });
    const worker = path.join(import.meta.dir, 'coordination-worker.ts');
    const children = [1, 2].map(() => spawn(process.execPath, [worker, root], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    await Promise.all(children.map(capture));
    const mutations = (await readFile(path.join(root, 'mutations.txt'), 'utf8'))
      .trim().split(/\r?\n/u).filter(Boolean);
    expect(mutations).toHaveLength(1);
  }, 30_000);
});

function capture(child: ChildProcess): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Child exited ${code}: ${stderr}`));
    });
  });
}

async function fileExists(file: string): Promise<boolean> {
  return Bun.file(file).exists();
}

function pythonFixture(overrides: Partial<PythonInfo> = {}): PythonInfo {
  const virtualEnvironment = overrides.virtualEnvironment ?? path.join(path.sep, 'managed', 'venv');
  return {
    executable: path.join(virtualEnvironment, 'bin', 'python'),
    baseExecutable: path.join(path.sep, 'managed', 'python', 'bin', 'python'),
    version: '3.12.7',
    major: 3,
    minor: 12,
    patch: 7,
    releaseLevel: 'final',
    implementation: 'cpython',
    architecture: process.arch === 'arm64' ? 'arm64' : 'amd64',
    pointerBits: process.arch === 'ia32' ? 32 : 64,
    prefix: virtualEnvironment,
    basePrefix: path.join(path.sep, 'managed', 'python'),
    virtualEnvironment,
    gilDisabled: false,
    embedding: null,
    ...overrides,
  };
}
