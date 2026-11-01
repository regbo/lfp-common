import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_REQUIRES_PYTHON,
  DEFAULT_REQUIRES_UV,
  createPyEnvironment,
  ensureEnvironment,
  ensureUv,
  resolveProjectRoot,
  uvSpawn,
  uvSpawnSync,
} from '../src/index.ts';
import { resolveOptions } from '../src/config.ts';
import {
  isValidPep440Specifier,
  maxPep440Version,
  pep440VersionSatisfies,
} from '../src/pep440.ts';
import { pythonSatisfiesPolicy, type PythonInfo } from '../src/probes.ts';
import { githubApiHeaders } from '../src/provision.ts';
import { buildUvCommand } from '../src/runners.ts';
import { canonicalPath, pathsEqual } from '../src/virtual-environment.ts';

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
  test('uses PEP 440 for Python and uv requirements', () => {
    expect(isValidPep440Specifier(DEFAULT_REQUIRES_PYTHON)).toBe(true);
    expect(isValidPep440Specifier(DEFAULT_REQUIRES_UV)).toBe(true);
    expect(pep440VersionSatisfies('3.10.0', DEFAULT_REQUIRES_PYTHON)).toBe(true);
    expect(pep440VersionSatisfies('4.0.0', DEFAULT_REQUIRES_PYTHON)).toBe(false);
    expect(pep440VersionSatisfies('3.11.9', '~=3.11.0')).toBe(true);
    expect(pep440VersionSatisfies('3.12.7', '==3.12.*')).toBe(true);
    expect(pep440VersionSatisfies('3.12.7', '>=3.10,!=3.12.*,<4')).toBe(false);
    expect(pep440VersionSatisfies('3.14rc2', '>=3.14rc1,<3.15')).toBe(true);
    expect(pep440VersionSatisfies('3.11.9', '===3.11.9')).toBe(true);
    expect(pep440VersionSatisfies('1!3.11.9', '==1!3.11.9')).toBe(true);
    expect(pep440VersionSatisfies('3.11.9.post1', '==3.11.9.post1')).toBe(true);
    expect(pep440VersionSatisfies('3.14.dev2', '==3.14.dev2')).toBe(true);
    expect(pep440VersionSatisfies('3.11.9+vendor.1', '==3.11.9+vendor.1')).toBe(true);
    expect(pep440VersionSatisfies('0.10.0', DEFAULT_REQUIRES_UV)).toBe(true);
    expect(pep440VersionSatisfies('0.9.9', DEFAULT_REQUIRES_UV)).toBe(false);
    expect(maxPep440Version(
      ['0.13.5', '0.14.0rc1', '0.13.6'],
      '>=0.13,<0.14',
    )).toBe('0.13.6');
  });

  test('centralizes configuration and explicitly prefers system Python', () => {
    const env = {
      PYFIG_REQUIRES_PYTHON: '>=3.11,<3.12',
      PYFIG_REQUIRES_UV: '>=0.11,<1',
      INIT_CWD: projectRoot,
    };
    const options = resolveOptions({
      dependencies: [' sniffio==1.3.1 ', 'idna==3.10', 'idna==3.10'],
      extras: ['Data_Base', 'data-base'],
      requiresPython: '==3.12.*',
      requiresUv: '==0.13.*',
      env,
    });
    env.PYFIG_REQUIRES_PYTHON = '>=3.10';
    env.PYFIG_REQUIRES_UV = '>=0.10';
    expect(options.requiresPython).toBe('==3.12.*');
    expect(options.requiresUv).toBe('==0.13.*');
    expect(options.dependencies).toEqual(['idna==3.10', 'sniffio==1.3.1']);
    expect(options.extras).toEqual(['data-base']);
    expect(options.projectRoot).toBe(projectRoot);
    expect(resolveOptions({ env: { PYFIG_AUTO_INSTALL: '0' } }).installPython).toBe(false);
  });

  test('authenticates GitHub release discovery when a token is available', () => {
    expect(githubApiHeaders({ GITHUB_TOKEN: 'actions-token' }).Authorization)
      .toBe('Bearer actions-token');
    expect(githubApiHeaders({ GH_TOKEN: 'cli-token' }).Authorization)
      .toBe('Bearer cli-token');
    expect(githubApiHeaders({})).not.toHaveProperty('Authorization');
    expect(() => githubApiHeaders({ GITHUB_TOKEN: 'bad\ntoken' })).toThrow('line breaks');
  });

  test('rejects invalid setup configuration before probing', () => {
    expect(() => resolveOptions({ requiresPython: 'nope' })).toThrow(
      'Invalid requires-python PEP 440 specifier',
    );
    expect(() => resolveOptions({ requiresUv: 'nope' })).toThrow(
      'Invalid requires-uv PEP 440 specifier',
    );
    expect(() => resolveOptions({ installTimeoutMs: 0 })).toThrow('positive integer');
    expect(() => resolveOptions({ dependencies: ['bad\nvalue'] })).toThrow(
      'Invalid runtime dependency',
    );
    expect(() => resolveOptions({ allExtras: true, extras: ['runtime'] })).toThrow(
      'allExtras cannot be combined',
    );
    expect(() => resolveOptions({
      managedPython: '3.9',
      requiresPython: '>=3.10,<4',
    })).toThrow('cannot satisfy requires-python');
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
    expect(environment.venvId).toMatch(/^[a-f0-9]{64}$/u);
    expect(isBelow(
      environment.python.virtualEnvironment ?? '',
      path.join(root, 'node_modules', '.pyfig', 'venvs'),
    )).toBe(true);
    expect(await fileExists(path.join(
      environment.python.virtualEnvironment ?? '',
      '.pyfig-venv.json',
    ))).toBe(true);
    expect(pep440VersionSatisfies(environment.python.version, DEFAULT_REQUIRES_PYTHON)).toBe(true);
  }, 60_000);

  test('reuses a compatible repository venv only for dependency-free clients', async () => {
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
    expect(environment.venvId).toBeNull();
    expect(pathsEqual(environment.python.virtualEnvironment ?? '', existing)).toBe(true);
    expect(await fileExists(path.join(root, 'node_modules', '.pyfig', 'venvs'))).toBe(false);

    const prepared = await createPyEnvironment({
      dependencies: ['idna==3.10'],
      projectRoot: root,
    }).prepare();
    expect(prepared.managed).toBe(true);
    expect(pathsEqual(prepared.python.virtualEnvironment ?? '', existing)).toBe(false);
    expect(isBelow(
      prepared.python.virtualEnvironment ?? '',
      path.join(root, 'node_modules', '.pyfig', 'venvs'),
    )).toBe(true);
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
    expect(isBelow(
      environment.python.virtualEnvironment ?? '',
      path.join(root, 'node_modules', '.pyfig', 'venvs'),
    )).toBe(true);
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

  test('leaves project inputs unchanged while installing runtime dependencies', async () => {
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
    const pyenv = createPyEnvironment({
      dependencies: ['sniffio==1.3.1'],
      extras: ['runtime'],
      projectRoot: root,
    });
    const environment = await pyenv.prepare();
    expect(await readFile(pyproject, 'utf8')).toBe(beforeProject);
    expect(await readFile(requirements, 'utf8')).toBe(beforeRequirements);
    const result = pyenv.uvSync(
      ['run', '--', 'python', '-c', 'import idna, sniffio; print(idna.__version__)'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(String(result.stdout).trim()).toBe('3.10');
    expect(environment.python.virtualEnvironment).toBeTruthy();
  }, 60_000);

  test('isolates different dependency sets and deduplicates identical resolutions', async () => {
    const root = path.join(temporaryRoot, 'multiple-environments');
    await mkdir(root, { recursive: true });
    const firstPyenv = createPyEnvironment({
      dependencies: ['idna==3.10', 'sniffio==1.3.1'],
      projectRoot: root,
    });
    const equivalentPyenv = createPyEnvironment({
      dependencies: ['sniffio==1.3.1', 'idna==3.10'],
      projectRoot: root,
    });
    const differentPyenv = createPyEnvironment({
      dependencies: ['urllib3==2.0.7'],
      projectRoot: root,
    });
    const [first, equivalent] = await Promise.all([
      firstPyenv.prepare(),
      equivalentPyenv.prepare(),
    ]);
    const different = await differentPyenv.prepare();

    expect(first.venvId).toBe(equivalent.venvId);
    expect(first.python.virtualEnvironment).toBe(equivalent.python.virtualEnvironment);
    expect(different.venvId).not.toBe(first.venvId);
    expect(different.python.virtualEnvironment).not.toBe(first.python.virtualEnvironment);

    const firstCheck = firstPyenv.uvSync(
      ['run', '--', 'python', '-c', 'import idna, sniffio; print(idna.__version__)'],
      { encoding: 'utf8' },
    );
    const differentCheck = differentPyenv.uvSync(
      ['run', '--', 'python', '-c', 'import urllib3; print(urllib3.__version__)'],
      { encoding: 'utf8' },
    );
    expect(firstCheck.status).toBe(0);
    expect(String(firstCheck.stdout).trim()).toBe('3.10');
    expect(differentCheck.status).toBe(0);
    expect(String(differentCheck.stdout).trim()).toBe('2.0.7');
  }, 90_000);

  test('validates native embedding requirements', () => {
    const python = pythonFixture({ embedding: null });
    const embeddingOptions = resolveOptions({ requireEmbedding: true, projectRoot });
    expect(pythonSatisfiesPolicy(python, embeddingOptions)).toBe(false);
    expect(pythonSatisfiesPolicy(
      { ...python, implementation: 'pypy' },
      embeddingOptions,
    )).toBe(false);

    const prereleaseOptions = resolveOptions({
      managedPython: '3.14',
      projectRoot,
      requiresPython: '>=3.14rc1,<3.15',
    });
    expect(pythonSatisfiesPolicy(
      pythonFixture({ minor: 14, patch: 0, releaseLevel: 'candidate', version: '3.14rc2' }),
      prereleaseOptions,
    )).toBe(true);
  });

  test('keeps the root API uv-centric', async () => {
    const api = await import('../src/index.ts');
    expect(Object.keys(api).sort()).toEqual([
      'DEFAULT_MANAGED_PYTHON',
      'DEFAULT_REQUIRES_PYTHON',
      'DEFAULT_REQUIRES_UV',
      'createPyEnvironment',
      'ensureEnvironment',
      'ensureUv',
      'resolveProjectRoot',
      'uvSpawn',
      'uvSpawnSync',
    ]);
  });

  test('memoizes venv preparation within one configured environment', async () => {
    const root = path.join(temporaryRoot, 'memoized-environment');
    await mkdir(root, { recursive: true });
    const pyenv = createPyEnvironment({ projectRoot: root });
    const first = pyenv.prepare();
    const second = pyenv.prepare();
    expect(second).toBe(first);
    expect(await second).toBe(await first);
  }, 60_000);

  test('memoizes uv resolution within a configured environment', async () => {
    const pyenv = createPyEnvironment({ projectRoot });
    const first = pyenv.uvInfo();
    const second = pyenv.uvInfo();
    expect(second).toBe(first);
    expect(await second).toBe(await first);
  }, 30_000);

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

function isBelow(candidate: string, directory: string): boolean {
  const relative = path.relative(canonicalPath(directory), canonicalPath(candidate));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
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
