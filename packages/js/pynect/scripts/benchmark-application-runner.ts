import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  connectModelCatalog,
  listModels,
} from '../../../py/pynect-worker-example/client.js';
import { startWorker } from '../src/worker.js';

const exampleRoot = fileURLToPath(new URL('../../../py/pynect-worker-example/', import.meta.url));
const pythonPath = fileURLToPath(new URL(
  process.platform === 'win32'
    ? '../../../../.venv/Scripts/python.exe'
    : '../../../../.venv/bin/python',
  import.meta.url,
));
const nativePath = fileURLToPath(new URL(
  '../../../py/pynect-worker-example/src/pynect_worker_example/benchmark_native.py',
  import.meta.url,
));

interface Summary {
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

interface NativeResult {
  readonly appImportMs: number;
  readonly appReadyToFirstMs: number;
  readonly processStartToFirstMs: number;
  readonly warmSamplesMs: readonly number[];
}

interface StdioResult {
  readonly spawnToHelloMs: number;
  readonly helloToAppReadyMs: number;
  readonly appReadyToFirstMs: number;
  readonly spawnToFirstMs: number;
  readonly warmSamplesMs: readonly number[];
}

interface NativeEvent {
  readonly event: 'ready' | 'first-response' | 'complete';
  readonly warmSamplesMs?: readonly number[];
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    iterations: { type: 'string', default: '1000' },
    json: { type: 'boolean', default: false },
    warmup: { type: 'string', default: '100' },
  },
  strict: true,
});
const iterations = positiveInteger(values.iterations, 'iterations');
const warmup = positiveInteger(values.warmup, 'warmup');
const [native, stdio] = await Promise.all([
  runNative(warmup, iterations),
  runStdio(warmup, iterations),
]);
const report = {
  native: {
    appImportMs: native.appImportMs,
    appReadyToFirstMs: native.appReadyToFirstMs,
    processStartToFirstMs: native.processStartToFirstMs,
    warmRequestMs: summarize(native.warmSamplesMs),
  },
  stdio: {
    spawnToHelloMs: stdio.spawnToHelloMs,
    helloToAppReadyMs: stdio.helloToAppReadyMs,
    appReadyToFirstMs: stdio.appReadyToFirstMs,
    spawnToFirstMs: stdio.spawnToFirstMs,
    warmRequestMs: summarize(stdio.warmSamplesMs),
  },
};

if (values.json) {
  console.log(JSON.stringify({
    environment: {
      bun: Bun.version,
      platform: `${process.platform}-${process.arch}`,
      python: pythonPath,
      runtime: process.version,
    },
    iterations,
    report,
    warmup,
  }, null, 2));
} else {
  console.log(`Bun ${Bun.version}; ${process.platform}-${process.arch}`);
  console.log(`${warmup} warmups + ${iterations} measured model-list operations.`);
  console.table([
    {
      path: 'Direct Python + JSON serialization',
      'runtime/app ready ms': round(report.native.appImportMs),
      'ready/first response ms': round(report.native.appReadyToFirstMs, 3),
      'start/first response ms': round(report.native.processStartToFirstMs),
      'warm p50 ms': round(report.native.warmRequestMs.p50, 3),
      'warm p95 ms': round(report.native.warmRequestMs.p95, 3),
      'warm p99 ms': round(report.native.warmRequestMs.p99, 3),
    },
    {
      path: 'Generated client over owned stdio',
      'runtime/app ready ms': round(report.stdio.spawnToHelloMs + report.stdio.helloToAppReadyMs),
      'ready/first response ms': round(report.stdio.appReadyToFirstMs, 3),
      'start/first response ms': round(report.stdio.spawnToFirstMs),
      'warm p50 ms': round(report.stdio.warmRequestMs.p50, 3),
      'warm p95 ms': round(report.stdio.warmRequestMs.p95, 3),
      'warm p99 ms': round(report.stdio.warmRequestMs.p99, 3),
    },
  ]);
  console.log('Direct timing starts immediately before Python spawn and separates app readiness from the first serialized operation.');
  console.log('stdio timing starts immediately before startWorker and separately reports PID hello, app imports, and the first generated-client response.');
}

async function runNative(warmupIterations: number, measuredIterations: number): Promise<NativeResult> {
  const startedAt = performance.now();
  const child = spawn(pythonPath, [nativePath, String(warmupIterations), String(measuredIterations)], {
    cwd: exampleRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  if (!child.stdout) throw new Error('Native benchmark stdout is unavailable.');
  let readyAt: number | undefined;
  let firstAt: number | undefined;
  let warmSamplesMs: readonly number[] | undefined;
  let failure: Error | undefined;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    if (line === 'BENCHMARK_START python') return;
    try {
      const event = JSON.parse(line) as NativeEvent;
      if (event.event === 'ready') readyAt = performance.now();
      else if (event.event === 'first-response') firstAt = performance.now();
      else if (event.event === 'complete') warmSamplesMs = event.warmSamplesMs;
      else failure = new Error(`Unknown native benchmark event: ${line}`);
    } catch (error) {
      failure = asError(error);
    }
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  lines.close();
  if (code !== 0) throw new Error(`Native benchmark exited with code ${code ?? 'unknown'}.`);
  if (failure) throw failure;
  if (readyAt === undefined || firstAt === undefined || !warmSamplesMs) {
    throw new Error('Native benchmark did not emit complete timing events.');
  }
  return {
    appImportMs: readyAt - startedAt,
    appReadyToFirstMs: firstAt - readyAt,
    processStartToFirstMs: firstAt - startedAt,
    warmSamplesMs,
  };
}

async function runStdio(warmupIterations: number, measuredIterations: number): Promise<StdioResult> {
  const output = new PassThrough();
  const appReady = Promise.withResolvers<number>();
  let ordinaryOutput = '';
  output.setEncoding('utf8');
  output.on('data', chunk => {
    ordinaryOutput += chunk;
    if (ordinaryOutput.includes('BENCHMARK_APP_READY')) appReady.resolve(performance.now());
  });
  const startedAt = performance.now();
  await using worker = await startWorker({
    app: 'pynect_worker_example.benchmark_app:app',
    python: pythonPath,
    root: exampleRoot,
    stdout: output,
  });
  const helloAt = performance.now();
  const appReadyAt = await withTimeout(appReady.promise, 30_000, 'Benchmark application import');
  const connection = connectModelCatalog(worker.clientOptions);
  try {
    await listModels(connection);
    const firstAt = performance.now();
    for (let index = 0; index < warmupIterations; index += 1) await listModels(connection);
    const warmSamplesMs: number[] = [];
    for (let index = 0; index < measuredIterations; index += 1) {
      const sampleStartedAt = performance.now();
      await listModels(connection);
      warmSamplesMs.push(performance.now() - sampleStartedAt);
    }
    return {
      spawnToHelloMs: helloAt - startedAt,
      helloToAppReadyMs: appReadyAt - helloAt,
      appReadyToFirstMs: firstAt - appReadyAt,
      spawnToFirstMs: firstAt - startedAt,
      warmSamplesMs,
    };
  } finally {
    connection.close();
  }
}

function summarize(samples: readonly number[]): Summary {
  if (samples.length === 0) throw new Error('Cannot summarize an empty sample set.');
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    mean: sorted.reduce((total, value) => total + value, 0) / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

function percentile(sorted: readonly number[], quantile: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]!;
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return parsed;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, purpose: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${purpose} timed out after ${timeoutMs} ms.`)), timeoutMs);
    timer.unref();
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
