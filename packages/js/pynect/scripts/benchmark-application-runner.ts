import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startWorker } from '../src/worker.js';

type ModelCatalogClient = typeof import('../../../py/pynect-example/client.js');

const exampleRoot = fileURLToPath(new URL('../../../py/pynect-example/', import.meta.url));
const pythonPath = requiredEnvironment('PYNECT_BENCHMARK_PYTHON_PATH');
const nativePath = fileURLToPath(new URL(
  '../../../py/pynect-example/src/pynect_example/benchmark_native.py',
  import.meta.url,
));
const launcherPath = fileURLToPath(new URL('./benchmark-application.ts', import.meta.url));
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

interface Summary {
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

interface StdioColdStartStages {
  readonly markerToRunnerReadyMs: number;
  readonly runnerReadyToWorkerStartMs: number;
  readonly workerStartToHelloMs: number;
  readonly helloToAppReadyMs: number;
}

interface ProcessResult {
  readonly runtimeStartToAppReadyMs: number;
  readonly appReadyToFirstMs: number;
  readonly runtimeStartToFirstMs: number;
  readonly stdioColdStartStages?: StdioColdStartStages;
  readonly warmSamplesMs: readonly number[];
}

interface BenchmarkEvent {
  readonly event:
    | 'runner-ready'
    | 'worker-start'
    | 'worker-hello'
    | 'ready'
    | 'first-response'
    | 'complete';
  readonly warmSamplesMs?: readonly number[];
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    child: { type: 'boolean', default: false },
    iterations: { type: 'string', default: '1000' },
    json: { type: 'boolean', default: false },
    warmup: { type: 'string', default: '100' },
  },
  strict: true,
});
const iterations = positiveInteger(values.iterations, 'iterations');
const warmup = positiveInteger(values.warmup, 'warmup');
if (values.child) {
  emit({ event: 'runner-ready' });
  await runStdioChild(warmup, iterations);
} else {
  await runComparison(warmup, iterations, values.json);
}

async function runComparison(
  warmupIterations: number,
  measuredIterations: number,
  json: boolean,
): Promise<void> {
  // Run sequentially so the native and IPC measurements do not contend for CPU.
  const native = await runProcess(
    pythonPath,
    [nativePath, String(warmupIterations), String(measuredIterations)],
    exampleRoot,
    'Native Python benchmark',
    'BENCHMARK_START python',
  );
  const stdio = await runProcess(
    process.execPath,
    [
      launcherPath,
      '--child',
      '--warmup', String(warmupIterations),
      '--iterations', String(measuredIterations),
    ],
    packageRoot,
    'Bun stdio benchmark',
    'BENCHMARK_START bun',
  );
  if (!stdio.stdioColdStartStages) {
    throw new Error('Bun stdio benchmark did not emit cold-start stage events.');
  }
  const report = {
    native: {
      runtimeStartToAppReadyMs: native.runtimeStartToAppReadyMs,
      appReadyToFirstMs: native.appReadyToFirstMs,
      runtimeStartToFirstMs: native.runtimeStartToFirstMs,
      warmRequestMs: summarize(native.warmSamplesMs),
    },
    stdio: {
      runtimeStartToAppReadyMs: stdio.runtimeStartToAppReadyMs,
      appReadyToFirstMs: stdio.appReadyToFirstMs,
      runtimeStartToFirstMs: stdio.runtimeStartToFirstMs,
      coldStartStagesMs: stdio.stdioColdStartStages,
      warmRequestMs: summarize(stdio.warmSamplesMs),
    },
  };

  if (json) {
    console.log(JSON.stringify({
      environment: {
        bun: Bun.version,
        platform: `${process.platform}-${process.arch}`,
        python: pythonPath,
        runtime: process.version,
      },
      iterations: measuredIterations,
      report,
      warmup: warmupIterations,
    }, null, 2));
    return;
  }

  console.log(`Bun ${Bun.version}; ${process.platform}-${process.arch}`);
  console.log(`${warmupIterations} warmups + ${measuredIterations} measured model-list operations.`);
  console.table([
    {
      path: 'Native Python + JSON serialization',
      'start marker/app ready ms': round(report.native.runtimeStartToAppReadyMs),
      'ready/first response ms': round(report.native.appReadyToFirstMs, 3),
      'start marker/first response ms': round(report.native.runtimeStartToFirstMs),
      'warm p50 ms': round(report.native.warmRequestMs.p50, 3),
      'warm p95 ms': round(report.native.warmRequestMs.p95, 3),
      'warm p99 ms': round(report.native.warmRequestMs.p99, 3),
    },
    {
      path: 'Bun + generated client + owned stdio',
      'start marker/app ready ms': round(report.stdio.runtimeStartToAppReadyMs),
      'ready/first response ms': round(report.stdio.appReadyToFirstMs, 3),
      'start marker/first response ms': round(report.stdio.runtimeStartToFirstMs),
      'warm p50 ms': round(report.stdio.warmRequestMs.p50, 3),
      'warm p95 ms': round(report.stdio.warmRequestMs.p95, 3),
      'warm p99 ms': round(report.stdio.warmRequestMs.p99, 3),
    },
  ]);
  console.table([
    {
      stage: 'Bun marker -> benchmark runner ready',
      ms: round(report.stdio.coldStartStagesMs.markerToRunnerReadyMs),
    },
    {
      stage: 'runner ready -> startWorker()',
      ms: round(report.stdio.coldStartStagesMs.runnerReadyToWorkerStartMs),
    },
    {
      stage: 'startWorker() -> Python hello',
      ms: round(report.stdio.coldStartStagesMs.workerStartToHelloMs),
    },
    {
      stage: 'Python hello -> application ready',
      ms: round(report.stdio.coldStartStagesMs.helloToAppReadyMs),
    },
  ]);
  console.log('Bun resolves pyfig().python.path before either cold clock. The generated client imports concurrently with Python startup. The stdio stages partition marker-to-app-ready; application-ready-to-first-response is shown separately. Warm samples exclude runtime and application startup.');
}

async function runProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  name: string,
  startMarker: string,
): Promise<ProcessResult> {
  const child = spawn(executable, [...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  if (!child.stdout) throw new Error(`${name} stdout is unavailable.`);
  let startedAt: number | undefined;
  let runnerReadyAt: number | undefined;
  let workerStartAt: number | undefined;
  let workerHelloAt: number | undefined;
  let readyAt: number | undefined;
  let firstAt: number | undefined;
  let warmSamplesMs: readonly number[] | undefined;
  let failure: Error | undefined;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    if (line === startMarker) {
      if (startedAt === undefined) startedAt = performance.now();
      else failure = new Error(`${name} emitted its start marker twice.`);
      return;
    }
    try {
      const event = JSON.parse(line) as BenchmarkEvent;
      if (event.event === 'runner-ready') runnerReadyAt = performance.now();
      else if (event.event === 'worker-start') workerStartAt = performance.now();
      else if (event.event === 'worker-hello') workerHelloAt = performance.now();
      else if (event.event === 'ready') readyAt = performance.now();
      else if (event.event === 'first-response') firstAt = performance.now();
      else if (event.event === 'complete') warmSamplesMs = event.warmSamplesMs;
      else failure = new Error(`Unknown ${name} event: ${line}`);
    } catch (error) {
      failure = asError(error);
    }
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  lines.close();
  if (code !== 0) throw new Error(`${name} exited with code ${code ?? 'unknown'}.`);
  if (failure) throw failure;
  if (startedAt === undefined || readyAt === undefined || firstAt === undefined || !warmSamplesMs) {
    throw new Error(`${name} did not emit complete timing events.`);
  }
  if (!(startedAt <= readyAt && readyAt <= firstAt)) {
    throw new Error(`${name} timing events arrived out of order.`);
  }
  const hasAnyStdioStage = runnerReadyAt !== undefined
    || workerStartAt !== undefined
    || workerHelloAt !== undefined;
  let stdioColdStartStages: StdioColdStartStages | undefined;
  if (hasAnyStdioStage) {
    if (runnerReadyAt === undefined || workerStartAt === undefined || workerHelloAt === undefined) {
      throw new Error(`${name} did not emit complete cold-start stage events.`);
    }
    if (!(startedAt <= runnerReadyAt
      && runnerReadyAt <= workerStartAt
      && workerStartAt <= workerHelloAt
      && workerHelloAt <= readyAt)) {
      throw new Error(`${name} cold-start stage events arrived out of order.`);
    }
    stdioColdStartStages = {
      markerToRunnerReadyMs: runnerReadyAt - startedAt,
      runnerReadyToWorkerStartMs: workerStartAt - runnerReadyAt,
      workerStartToHelloMs: workerHelloAt - workerStartAt,
      helloToAppReadyMs: readyAt - workerHelloAt,
    };
  }
  return {
    runtimeStartToAppReadyMs: readyAt - startedAt,
    appReadyToFirstMs: firstAt - readyAt,
    runtimeStartToFirstMs: firstAt - startedAt,
    ...(stdioColdStartStages ? { stdioColdStartStages } : {}),
    warmSamplesMs,
  };
}

async function runStdioChild(
  warmupIterations: number,
  measuredIterations: number,
): Promise<void> {
  const output = new PassThrough();
  const appReady = Promise.withResolvers<void>();
  let ordinaryOutput = '';
  output.setEncoding('utf8');
  output.on('data', chunk => {
    ordinaryOutput += chunk;
    if (ordinaryOutput.includes('BENCHMARK_APP_READY')) appReady.resolve();
  });
  emit({ event: 'worker-start' });
  const workerPromise = startWorker({
    app: 'pynect_example.benchmark_app:app',
    python: pythonPath,
    root: exampleRoot,
    stdout: output,
  });
  const clientPromise: Promise<ModelCatalogClient> = import('../../../py/pynect-example/client.js');
  await using worker = await workerPromise;
  emit({ event: 'worker-hello' });
  await withTimeout(appReady.promise, 30_000, 'Benchmark application import');
  emit({ event: 'ready' });
  const client = await clientPromise;
  const connection = client.connectModelCatalog(worker.clientOptions);
  try {
    await client.listModels(connection);
    emit({ event: 'first-response' });
    for (let index = 0; index < warmupIterations; index += 1) await client.listModels(connection);
    const warmSamplesMs: number[] = [];
    for (let index = 0; index < measuredIterations; index += 1) {
      const sampleStartedAt = performance.now();
      await client.listModels(connection);
      warmSamplesMs.push(performance.now() - sampleStartedAt);
    }
    emit({ event: 'complete', warmSamplesMs });
  } finally {
    connection.close();
  }
}

function emit(event: BenchmarkEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
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

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be resolved before benchmarking.`);
  return value;
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
