import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pyfig } from 'pyfig';
import {
  createVenv,
  kwargs,
  type PythonObject,
} from '../src/js';

const WARM_RUNS = 5;
const PAYLOAD = `pynect-smoke:${'0123456789abcdef'.repeat(256)}`;
const packageRoot = path.resolve(import.meta.dir, '..');
const noProxyEnvironment = {
  NO_PROXY: 'localhost,127.0.0.1',
  no_proxy: 'localhost,127.0.0.1',
} as const;

const PURE_PYTHON_IO = String.raw`
import json
import pathlib
import sys
import time
import urllib.request


def read_value(kind: str, target: str) -> str:
    if kind == "file":
        return pathlib.Path(target).read_text(encoding="utf-8")
    if kind == "http":
        with urllib.request.urlopen(target, timeout=5) as response:
            return response.read().decode("utf-8")
    raise ValueError(f"unknown I/O kind: {kind}")


def main() -> None:
    kind, target, count_text = sys.argv[1:4]
    values: list[str] = []
    milliseconds: list[float] = []
    for _ in range(int(count_text)):
        started = time.perf_counter()
        values.append(read_value(kind, target))
        milliseconds.append((time.perf_counter() - started) * 1000)
    print(json.dumps({"milliseconds": milliseconds, "values": values}))


if __name__ == "__main__":
    main()
`;

interface PynectMeasurement {
  readonly firstMilliseconds: number;
  readonly firstValue: string;
  readonly warmMilliseconds: readonly number[];
  readonly warmValues: readonly string[];
}

interface PurePythonMeasurement {
  readonly milliseconds: readonly number[];
  readonly values: readonly string[];
}

let server: Server | undefined;
let temporaryDirectory: string | undefined;
let smokeFile = '';
let ipUrl = '';
let hostnameUrl = '';
let uvPath = '';
let pythonPath = '';

beforeAll(async () => {
  // Finish fixture and server setup before any benchmark timer starts.
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'pynect-io-smoke-'));
  smokeFile = path.join(temporaryDirectory, 'payload.txt');
  await writeFile(smokeFile, PAYLOAD, 'utf8');

  server = createServer((_request, response) => {
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(PAYLOAD),
      'content-type': 'text/plain; charset=utf-8',
    });
    response.end(PAYLOAD);
  });
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen({ host: '::', ipv6Only: false, port: 0 }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Smoke server has no TCP port.');
  ipUrl = `http://127.0.0.1:${address.port}/payload`;
  hostnameUrl = `http://localhost:${address.port}/payload`;

  const environment = await pyfig({
    cwd: packageRoot,
    env: noProxyEnvironment,
  });
  await environment.python.resolve();
  uvPath = environment.uv.path;
  pythonPath = environment.python.path ?? '';
  if (!pythonPath) throw new Error('Pyfig did not expose its resolved Python path.');
});

afterAll(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server?.close(() => resolve()));
  }
  if (temporaryDirectory) {
    const resolvedTemporary = path.resolve(temporaryDirectory);
    if (path.dirname(resolvedTemporary) !== path.resolve(os.tmpdir())) {
      throw new Error(`Refusing to remove unexpected smoke directory: ${resolvedTemporary}`);
    }
    await rm(resolvedTemporary, { force: true, recursive: true });
  }
});

describe('Pynect I/O smoke benchmarks', () => {
  test('reads a loopback URL by numeric IP and hostname', async () => {
    const venv = createVenv({
      autoClose: false,
      env: noProxyEnvironment,
      project: false,
    });
    try {
      const urllib = await venv.import('urllib.request');
      expect(await readUrl(urllib, ipUrl)).toBe(PAYLOAD);
      expect(await readUrl(urllib, hostnameUrl)).toBe(PAYLOAD);
      expect((await runUvPython('http', hostnameUrl, 1)).values).toEqual([PAYLOAD]);
    } finally {
      await venv.close();
    }
  }, 120_000);

  test('reads a local file through Pynect and uv-run Python', async () => {
    const venv = createVenv({ autoClose: false, project: false });
    try {
      const pathlib = await venv.import('pathlib');
      expect(await readFile(pathlib, smokeFile)).toBe(PAYLOAD);
      expect((await runUvPython('file', smokeFile, 1)).values).toEqual([PAYLOAD]);
    } finally {
      await venv.close();
    }
  }, 120_000);

  test('reports first and warm Pynect versus uv-run Python timings', async () => {
    const pynectHttp = await measurePynect('urllib.request', module => readUrl(module, ipUrl));
    const pureHttpCold = await runUvPython('http', ipUrl, 1);
    const pureHttpWarm = await runUvPython('http', ipUrl, WARM_RUNS);
    const pynectFile = await measurePynect('pathlib', module => readFile(module, smokeFile));
    const pureFileCold = await runUvPython('file', smokeFile, 1);
    const pureFileWarm = await runUvPython('file', smokeFile, WARM_RUNS);

    for (const measurement of [pynectHttp, pynectFile]) {
      expect(measurement.firstValue).toBe(PAYLOAD);
      expect(measurement.warmValues).toEqual(Array(WARM_RUNS).fill(PAYLOAD));
      expect(measurement.firstMilliseconds).toBeGreaterThan(0);
    }
    for (const measurement of [pureHttpCold, pureHttpWarm, pureFileCold, pureFileWarm]) {
      expect(measurement.values).toEqual(Array(measurement.values.length).fill(PAYLOAD));
      expect(measurement.milliseconds.every(value => value > 0)).toBe(true);
    }

    console.table([
      timingRow('loopback HTTP', 'Pynect', pynectHttp.firstMilliseconds,
        median(pynectHttp.warmMilliseconds)),
      timingRow('loopback HTTP', 'uv run Python', median(pureHttpCold.milliseconds),
        median(pureHttpWarm.milliseconds)),
      timingRow('local file', 'Pynect', pynectFile.firstMilliseconds,
        median(pynectFile.warmMilliseconds)),
      timingRow('local file', 'uv run Python', median(pureFileCold.milliseconds),
        median(pureFileWarm.milliseconds)),
    ]);
  }, 120_000);
});

async function measurePynect(
  moduleName: string,
  operation: (module: PythonObject) => Promise<string>,
): Promise<PynectMeasurement> {
  const venv = createVenv({
    autoClose: false,
    env: noProxyEnvironment,
    project: false,
  });
  try {
    const module = await venv.import(moduleName);
    const firstStarted = performance.now();
    const firstValue = await operation(module);
    const firstMilliseconds = performance.now() - firstStarted;
    const warmMilliseconds: number[] = [];
    const warmValues: string[] = [];
    for (let run = 0; run < WARM_RUNS; run += 1) {
      const started = performance.now();
      warmValues.push(await operation(module));
      warmMilliseconds.push(performance.now() - started);
    }
    return { firstMilliseconds, firstValue, warmMilliseconds, warmValues };
  } finally {
    await venv.close();
  }
}

async function readUrl(urllib: PythonObject, url: string): Promise<string> {
  const response = await urllib.urlopen(url, kwargs({ timeout: 5 })) as PythonObject;
  try {
    const value = await response.read();
    if (!(value instanceof Uint8Array)) throw new TypeError('Python returned a non-byte response.');
    return Buffer.from(value).toString('utf8');
  } finally {
    await response.close();
    await response.$release();
  }
}

async function readFile(pathlib: PythonObject, filename: string): Promise<string> {
  const file = await pathlib.Path(filename) as PythonObject;
  try {
    const value = await file.read_text(kwargs({ encoding: 'utf-8' }));
    if (typeof value !== 'string') throw new TypeError('Python returned non-text file contents.');
    return value;
  } finally {
    await file.$release();
  }
}

function runUvPython(
  kind: 'file' | 'http',
  target: string,
  runs: number,
): Promise<PurePythonMeasurement> {
  return new Promise((resolve, reject) => {
    const child = spawn(uvPath, [
      'run',
      '--quiet',
      '--no-project',
      '--no-python-downloads',
      '--python',
      pythonPath,
      '--',
      'python',
      '-I',
      '-S',
      '-c',
      PURE_PYTHON_IO,
      kind,
      target,
      String(runs),
    ], {
      cwd: packageRoot,
      env: { ...process.env, ...noProxyEnvironment },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => stdout += chunk);
    child.stderr.on('data', (chunk: string) => stderr += chunk);
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) {
        reject(new Error(`uv-run Python smoke failed (${code ?? 'unknown'}): ${stderr.trim()}`));
        return;
      }
      try {
        const output = JSON.parse(stdout) as {
          milliseconds?: unknown;
          values?: unknown;
        };
        if (!Array.isArray(output.milliseconds) ||
            !output.milliseconds.every(value => typeof value === 'number') ||
            output.milliseconds.length !== runs ||
            !Array.isArray(output.values) ||
            !output.values.every(value => typeof value === 'string') ||
            output.values.length !== runs) {
          throw new TypeError('uv-run Python returned malformed benchmark output.');
        }
        resolve({
          milliseconds: output.milliseconds as number[],
          values: output.values as string[],
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? ((ordered[midpoint - 1] ?? 0) + (ordered[midpoint] ?? 0)) / 2
    : ordered[midpoint] ?? 0;
}

function timingRow(
  operation: string,
  runtime: string,
  firstMilliseconds: number,
  warmMilliseconds: number,
): Record<string, string> {
  return {
    'first read ms': firstMilliseconds.toFixed(2),
    operation,
    runtime,
    'warm median ms': warmMilliseconds.toFixed(2),
  };
}
