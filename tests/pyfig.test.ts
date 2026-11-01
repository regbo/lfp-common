import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import semver from 'semver';
import {
  DEFAULT_PIP_RANGE,
  DEFAULT_PYTHON_RANGE,
  clearPyfigCaches,
  createPyfig,
  ensureEnvironment,
  ensureUv,
  pipSpawn,
  pipSpawnSync,
  pythonSpawn,
  pythonSpawnSync,
  resolveProjectRoot,
  uvSpawn,
  uvSpawnSync,
} from '../src/index.ts';
import { resolveOptions } from '../src/config.ts';
import {
  parsePipVersionOutput,
  pipBelongsToPython,
  pythonSatisfiesRequirements,
  type PythonInfo,
} from '../src/probes.ts';
import { ensurePip, ensurePython } from '../src/provision.ts';
import { buildPipCommand, buildUvCommand } from '../src/runners.ts';
import { memoizeAsync } from '../src/state.ts';

let projectRoot = '';
let noUvCacheDir = '';
let noUvEnv: NodeJS.ProcessEnv = {};
let concurrentEnvironments: Awaited<ReturnType<typeof ensureEnvironment>>[] = [];

beforeAll(async () => {
  projectRoot = await mkdtemp(path.join(os.tmpdir(), 'pyfig-project-'));
  noUvCacheDir = path.join(projectRoot, 'pyfig-cache');
  noUvEnv = { ...process.env, PYFIG_UV: path.join(projectRoot, 'missing-uv') };
  await writeFile(path.join(projectRoot, 'package.json'), '{"name":"pyfig-test","private":true}\n');
  concurrentEnvironments = await Promise.all([
    ensureEnvironment({ projectRoot, cacheDir: noUvCacheDir, env: noUvEnv, installUv: false }),
    ensureEnvironment({ projectRoot, cacheDir: noUvCacheDir, env: noUvEnv, installUv: false }),
  ]);
}, 60_000);

afterAll(async () => {
  if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
});

describe('pyfig', () => {
  test('uses valid, sensible default ranges', () => {
    expect(semver.validRange(DEFAULT_PYTHON_RANGE)).not.toBeNull();
    expect(semver.validRange(DEFAULT_PIP_RANGE)).not.toBeNull();
    expect(semver.satisfies('3.10.0', DEFAULT_PYTHON_RANGE)).toBe(true);
    expect(semver.satisfies('4.0.0', DEFAULT_PYTHON_RANGE)).toBe(false);
  });

  test('applies options over environment values', () => {
    const options = resolveOptions({
      pythonRange: '>=3.12.0 <3.13.0',
      env: { PYFIG_PYTHON_RANGE: '>=3.11.0 <3.12.0' },
    });
    expect(options.pythonRange).toBe('>=3.12.0 <3.13.0');
    expect(resolveOptions({ env: { PYFIG_AUTO_INSTALL: '0' } }).autoInstall).toBe(false);
    expect(resolveOptions({ env: { PYFIG_AUTO_INSTALL: '0' } }).installPython).toBe(false);
    expect(resolveOptions({
      autoInstall: false,
      createVirtualEnvironment: true,
      installUv: true,
      env: {},
    })).toMatchObject({
      installPython: false,
      installUv: true,
      createVirtualEnvironment: true,
    });
    expect(resolveOptions({ env: { PYFIG_PIP: 'standalone-pip' } })).not.toHaveProperty('pip');
  });

  test('snapshots environment configuration at resolution time', () => {
    const env = { PATH: 'first' };
    const options = resolveOptions({ env, projectRoot });
    env.PATH = 'second';
    expect(options.env['PATH']).toBe('first');
  });

  test('discovers this single-package project from a subdirectory', () => {
    expect(resolveProjectRoot(path.join(process.cwd(), 'src'))).toBe(process.cwd());
  });

  test('rejects malformed ranges before probing', () => {
    expect(() => resolveOptions({ pythonRange: 'nope' })).toThrow('Invalid Python SemVer range');
    expect(() => resolveOptions({ pipRange: 'nope' })).toThrow('Invalid pip SemVer range');
    expect(() => resolveOptions({ uvVersion: '../uv' })).toThrow('Invalid exact uv version');
    expect(() => resolveOptions({ installTimeoutMs: 0 })).toThrow('positive integer');
    expect(() => resolveOptions({
      managedPython: '3.9',
      pythonRange: '>=3.10.0 <4.0.0',
    })).toThrow('cannot satisfy configured range');
  });

  test('detects the repo-local environment without installing', async () => {
    const environment = await ensureEnvironment({
      autoInstall: false,
      projectRoot,
      cacheDir: noUvCacheDir,
      env: noUvEnv,
    });
    const expectedVenv = path.join(projectRoot, '.venv');
    expect(semver.satisfies(environment.python.version, DEFAULT_PYTHON_RANGE)).toBe(true);
    expect(environment.python.virtualEnvironment).toBe(expectedVenv);
    expect(environment.python.prefix).toBe(expectedVenv);
    expect(environment.packageManager.kind).toBe('pip');
    expect(semver.satisfies(environment.packageManager.version, DEFAULT_PIP_RANGE)).toBe(true);
    expect(environment.packageManager.executable).toBe(environment.python.executable);
    expect(environment.packageManager.prefixArgs).toEqual(['-m', 'pip']);
    expect(environment.packageManager.pythonExecutable).toBe(environment.python.executable);
    expect(environment.packageManager.virtualEnvironment).toBe(expectedVenv);
  }, 15_000);

  test('prefers an existing uv over venv pip', async () => {
    const uv = await ensureUv({ autoInstall: false, projectRoot }).catch(() => null);
    const environment = await ensureEnvironment({ autoInstall: false, projectRoot });
    if (uv) {
      expect(environment.packageManager.kind).toBe('uv');
      expect(environment.packageManager.executable).toBe(uv.executable);
    } else {
      expect(environment.packageManager.kind).toBe('pip');
    }
  });

  test('uses check-lock-check creation for concurrent repo-local venv requests', () => {
    const expectedVenv = path.join(projectRoot, '.venv');
    expect(concurrentEnvironments).toHaveLength(2);
    expect(concurrentEnvironments.every(
      (environment) => environment.python.virtualEnvironment === expectedVenv,
    )).toBe(true);
  });

  test('validates that python -m pip belongs to the selected interpreter', () => {
    const python: PythonInfo = {
      executable: path.join('C:', 'Python312', 'python.exe'),
      baseExecutable: path.join('C:', 'Python312', 'python.exe'),
      version: '3.12.7',
      major: 3,
      minor: 12,
      patch: 7,
      releaseLevel: 'final',
      implementation: 'cpython',
      architecture: process.arch === 'arm64' ? 'arm64' : 'amd64',
      pointerBits: process.arch === 'ia32' ? 32 : 64,
      prefix: path.join('C:', 'Python312'),
      basePrefix: path.join('C:', 'Python312'),
      virtualEnvironment: null,
      gilDisabled: false,
      embedding: null,
    };
    const matching = parsePipVersionOutput(
      `pip 25.2 from ${path.join(python.prefix, 'Lib', 'site-packages', 'pip')} (python 3.12)`,
    );
    const other = parsePipVersionOutput(
      `pip 25.2 from ${path.join('C:', 'Python313', 'Lib', 'site-packages', 'pip')} (python 3.13)`,
    );
    expect(matching).not.toBeNull();
    expect(other).not.toBeNull();
    expect(pipBelongsToPython(matching!, python)).toBe(true);
    expect(pipBelongsToPython(other!, python)).toBe(false);
  });

  test('pins pipSpawn and uv pip commands to the same selected Python', () => {
    const virtualEnvironment = path.join(path.sep, 'managed', '.venv');
    const pythonExecutable = path.join(virtualEnvironment, 'bin', 'python');
    const python: PythonInfo = {
      executable: pythonExecutable,
      baseExecutable: path.join(path.sep, 'managed', 'python', 'python'),
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
    };
    const pipCommand = buildPipCommand({
      kind: 'uv',
      executable: 'uv',
      prefixArgs: ['pip'],
      version: '0.13.6',
      pythonExecutable,
      virtualEnvironment,
    }, ['install', 'ruff'], { PATH: '/bin', UV_PYTHON: '/wrong/python' });
    const uvCommand = buildUvCommand(
      { executable: 'uv', version: '0.13.6' },
      ['--quiet', 'pip', 'install', 'ruff'],
      resolveOptions({ env: { PATH: '/bin' }, projectRoot }),
      python,
    );
    expect(pipCommand.args).toEqual(['pip', 'install', 'ruff']);
    expect(uvCommand.args).toEqual(['--quiet', 'pip', 'install', 'ruff']);
    expect(pipCommand.env['UV_PYTHON']).toBe(pythonExecutable);
    expect(uvCommand.env['UV_PYTHON']).toBe(pythonExecutable);
    expect(pipCommand.env['VIRTUAL_ENV']).toBe(virtualEnvironment);
    expect(uvCommand.env['VIRTUAL_ENV']).toBe(virtualEnvironment);
    expect(pipCommand.env['PATH']?.split(path.delimiter)[0]).toBe(path.dirname(pythonExecutable));
    expect(uvCommand.env['PATH']?.split(path.delimiter)[0]).toBe(path.dirname(pythonExecutable));
  });

  test('builds uv commands with pyfig-managed cache directories', () => {
    const cacheDir = path.join(projectRoot, 'uv-command-cache');
    const options = resolveOptions({ cacheDir, env: { PATH: '/bin' }, projectRoot });
    const command = buildUvCommand(
      { executable: 'uv', version: '0.13.6' },
      ['python', 'list'],
      options,
    );
    expect(command.args).toEqual(['python', 'list']);
    expect(command.env['UV_PYTHON_INSTALL_DIR']).toBe(path.join(cacheDir, 'python'));
    expect(command.env['UV_CACHE_DIR']).toBe(path.join(cacheDir, 'uv-cache'));
  });

  test('spawns the selected Python asynchronously and synchronously', async () => {
    const asyncResult = await capture(await pythonSpawn(
      ['-c', 'import json,os,sys;print(json.dumps([sys.prefix,os.environ.get("VIRTUAL_ENV")]))'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
      { autoInstall: false, projectRoot },
    ));
    expect(JSON.parse(asyncResult.stdout)).toEqual([
      path.join(projectRoot, '.venv'),
      path.join(projectRoot, '.venv'),
    ]);

    const syncResult = pythonSpawnSync(
      ['-c', 'import json,os,sys;print(json.dumps([sys.prefix,os.environ.get("VIRTUAL_ENV")]))'],
      { encoding: 'utf8' },
      { autoInstall: false, projectRoot },
    );
    expect(syncResult.status).toBe(0);
    expect(JSON.parse(String(syncResult.stdout))).toEqual([
      path.join(projectRoot, '.venv'),
      path.join(projectRoot, '.venv'),
    ]);
  }, 30_000);

  test('spawns pip for the selected Python asynchronously and synchronously', async () => {
    const asyncResult = await capture(await pipSpawn(
      ['list', '--format', 'json'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
      { autoInstall: false, projectRoot },
    ));
    expect(Array.isArray(JSON.parse(asyncResult.stdout))).toBe(true);

    const syncResult = pipSpawnSync(
      ['list', '--format', 'json'],
      { encoding: 'utf8' },
      { autoInstall: false, projectRoot },
    );
    expect(syncResult.status).toBe(0);
    expect(Array.isArray(JSON.parse(String(syncResult.stdout)))).toBe(true);
  }, 30_000);

  test('ensures and spawns uv asynchronously and synchronously', async () => {
    let uv;
    try {
      uv = await ensureUv({ autoInstall: false, projectRoot });
    } catch {
      await expect(uvSpawn(
        ['--version'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
        { autoInstall: false, projectRoot },
      )).rejects.toThrow('uv is unavailable');
      expect(() => uvSpawnSync(
        ['--version'],
        { encoding: 'utf8' },
        { autoInstall: false, projectRoot },
      )).toThrow('uv is unavailable');
      return;
    }

    const asyncResult = await capture(await uvSpawn(
      ['--version'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
      { autoInstall: false, projectRoot },
    ));
    expect(asyncResult.stdout).toContain(`uv ${uv.version}`);

    const syncResult = uvSpawnSync(
      ['--version'],
      { encoding: 'utf8' },
      { autoInstall: false, projectRoot },
    );
    expect(syncResult.status).toBe(0);
    expect(String(syncResult.stdout)).toContain(`uv ${uv.version}`);

    const asyncPipResult = await capture(await uvSpawn(
      ['pip', 'list', '--format', 'json'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
      { autoInstall: false, projectRoot },
    ));
    expect(Array.isArray(JSON.parse(asyncPipResult.stdout))).toBe(true);

    const syncPipResult = uvSpawnSync(
      ['pip', 'list', '--format', 'json'],
      { encoding: 'utf8' },
      { autoInstall: false, projectRoot },
    );
    expect(syncPipResult.status).toBe(0);
    expect(Array.isArray(JSON.parse(String(syncPipResult.stdout)))).toBe(true);
  }, 30_000);

  test('honors disabled fallback for an incompatible pip range', async () => {
    const python = await ensurePython({ autoInstall: false, projectRoot });
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'pyfig-test-'));
    try {
      await expect(ensurePip({
        autoInstall: false,
        pipRange: '>=999.0.0',
        cacheDir,
        projectRoot,
        env: { ...process.env, PYFIG_UV: path.join(cacheDir, 'missing-uv') },
      }, python)).rejects.toThrow('uv installation is disabled');
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  }, 15_000);

  test('does not create a missing venv when automatic setup is disabled', async () => {
    const emptyRoot = await mkdtemp(path.join(os.tmpdir(), 'pyfig-empty-'));
    try {
      await expect(ensureEnvironment({
        autoInstall: false,
        projectRoot: emptyRoot,
      })).rejects.toThrow('No virtual environment');
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });

  test('can require CPython embedding development files', async () => {
    const python = await ensurePython({
      autoInstall: false,
      projectRoot,
      requireEmbedding: true,
    });
    expect(python.embedding).not.toBeNull();
    expect(python.embedding?.includeDirectory).toBeTruthy();
    expect(python.embedding?.libraryPath).toBeTruthy();
    expect(pythonSatisfiesRequirements(python, resolveOptions({
      autoInstall: false,
      projectRoot,
      requireEmbedding: true,
    }))).toBe(true);
    expect(pythonSatisfiesRequirements(
      { ...python, implementation: 'pypy' },
      resolveOptions({ autoInstall: false, projectRoot, requireEmbedding: true }),
    )).toBe(false);
    expect(pythonSatisfiesRequirements(
      { ...python, pointerBits: python.pointerBits === 64 ? 32 : 64 },
      resolveOptions({ autoInstall: false, projectRoot, requireEmbedding: true }),
    )).toBe(false);
  });

  test('keeps the root API focused on consumer operations', async () => {
    const api = await import('../src/index.ts');
    expect(Object.keys(api).sort()).toEqual([
      'DEFAULT_MANAGED_PYTHON',
      'DEFAULT_PIP_RANGE',
      'DEFAULT_PYTHON_RANGE',
      'DEFAULT_UV_RANGE',
      'DEFAULT_UV_VERSION',
      'clearPyfigCaches',
      'createPyfig',
      'ensureEnvironment',
      'ensureUv',
      'ensureVirtualEnvironment',
      'pipSpawn',
      'pipSpawnSync',
      'pythonSpawn',
      'pythonSpawnSync',
      'resolveProjectRoot',
      'uvSpawn',
      'uvSpawnSync',
    ]);
  });

  test('memoizes validated environment resolutions for a scoped client', async () => {
    clearPyfigCaches();
    const client = createPyfig({ autoInstall: false, projectRoot });
    const first = await client.prepare();
    const second = await client.prepare();
    expect(second).toBe(first);
  });

  test('runs Python without requiring pip or uv resolution', async () => {
    const result = await capture(await pythonSpawn(
      ['-c', 'import sys; print(sys.executable)'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
      {
        autoInstall: false,
        pipRange: '>=999.0.0',
        projectRoot,
        env: noUvEnv,
      },
    ));
    expect(path.resolve(result.stdout.trim())).toBe(
      path.resolve(projectRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    );
  });

  test('reuses the repo environment when PATH exposes no Python or uv', async () => {
    const emptyPath = await mkdtemp(path.join(os.tmpdir(), 'pyfig-empty-path-'));
    try {
      clearPyfigCaches();
      const result = await capture(await pythonSpawn(
        ['-c', 'import sys; print(sys.executable)'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
        {
          autoInstall: false,
          projectRoot,
          cacheDir: path.join(emptyPath, 'cache'),
          env: { ...process.env, PATH: emptyPath },
        },
      ));
      expect(path.resolve(result.stdout.trim())).toBe(
        path.resolve(projectRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
      );
    } finally {
      await rm(emptyPath, { recursive: true, force: true });
    }
  });

  test('rejects every package target escape and sanitizes inherited targeting', () => {
    const virtualEnvironment = path.join(path.sep, 'managed', '.venv');
    const pythonExecutable = path.join(virtualEnvironment, 'bin', 'python');
    const python = pythonFixture({ executable: pythonExecutable, virtualEnvironment });
    const uvManager = {
      kind: 'uv' as const,
      executable: 'uv',
      prefixArgs: ['pip'],
      version: '0.13.6',
      pythonExecutable,
      virtualEnvironment,
    };
    const pipManager = { ...uvManager, kind: 'pip' as const, executable: pythonExecutable };

    expect(() => buildPipCommand(uvManager, ['install', '--system', 'ruff'], {}))
      .toThrow('--system is not allowed');
    expect(() => buildPipCommand(uvManager, ['install', '-t', '/tmp/escape', 'ruff'], {}))
      .toThrow('-t is not allowed');
    expect(() => buildPipCommand(pipManager, ['install', 'ruff'], {}))
      .toThrow('Package mutation requires uv');
    expect(() => buildUvCommand(
      { executable: 'uv', version: '0.13.6' },
      ['pip', 'install', '--python=/other/python', 'ruff'],
      resolveOptions({ projectRoot }),
      python,
    )).toThrow('--python is not allowed');
    expect(() => buildUvCommand(
      { executable: 'uv', version: '0.13.6' },
      ['pip', 'install', '-p/other/python', 'ruff'],
      resolveOptions({ projectRoot }),
      python,
    )).toThrow('-p is not allowed');

    const command = buildPipCommand(uvManager, ['list'], {
      PIP_PYTHON: '/other/python',
      UV_SYSTEM_PYTHON: '1',
      UV_TARGET: '/tmp/escape',
    });
    expect(command.env['PIP_PYTHON']).toBeUndefined();
    expect(command.env['UV_SYSTEM_PYTHON']).toBeUndefined();
    expect(command.env['UV_TARGET']).toBeUndefined();
    expect(command.env['UV_NO_CONFIG']).toBe('1');
    expect(command.env['UV_PYTHON']).toBe(pythonExecutable);
  });

  test('discovers a pure Python project root from pyproject metadata', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pyfig-python-root-'));
    const nested = path.join(root, 'src', 'package');
    try {
      await mkdir(nested, { recursive: true });
      await writeFile(path.join(root, 'pyproject.toml'), '[project]\nname = "example"\n');
      expect(resolveProjectRoot(nested)).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('serializes check-lock-check provisioning across separate processes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pyfig-lock-test-'));
    try {
      const worker = path.join(import.meta.dir, 'coordination-worker.ts');
      const children = [1, 2].map(() => spawn(process.execPath, [worker, root], {
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
      await Promise.all(children.map(capture));
      const mutations = (await readFile(path.join(root, 'mutations.txt'), 'utf8'))
        .trim().split(/\r?\n/u).filter(Boolean);
      expect(mutations).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('does not let cleared in-flight work repopulate completed caches', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let loads = 0;
    const first = memoizeAsync(
      'cache-race-test',
      'resource',
      60_000,
      () => true,
      async () => {
        loads += 1;
        await gate;
        return 'stale';
      },
    );
    clearPyfigCaches();
    release();
    expect(await first).toBe('stale');
    const second = await memoizeAsync(
      'cache-race-test',
      'resource',
      60_000,
      () => true,
      async () => {
        loads += 1;
        return 'fresh';
      },
    );
    expect(second).toBe('fresh');
    expect(loads).toBe(2);
  });
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

function pythonFixture(overrides: Partial<PythonInfo> = {}): PythonInfo {
  const virtualEnvironment = overrides.virtualEnvironment ?? path.join(path.sep, 'managed', '.venv');
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
