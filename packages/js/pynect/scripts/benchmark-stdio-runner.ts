import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { StdioOutputParser } from '../src/stdio-protocol.js';

const exampleRoot = fileURLToPath(new URL('../../../py/pynect-worker-example/', import.meta.url));
const pythonPath = fileURLToPath(new URL(
  process.platform === 'win32'
    ? '../../../../.venv/Scripts/python.exe'
    : '../../../../.venv/bin/python',
  import.meta.url,
));
const workerPath = fileURLToPath(new URL(
  '../../../py/pynect-worker-example/src/pynect_worker_example/benchmark_stdio.py',
  import.meta.url,
));
const launcherPath = fileURLToPath(new URL('./benchmark-stdio.ts', import.meta.url));
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const benchmarkStart = 'BENCHMARK_START python-spawn';
const timeoutMs = 30_000;

interface HelloEvent {
  readonly type: 'hello';
  readonly pid: number;
  readonly protocol: number;
}

interface PongEvent {
  readonly type: 'pong';
  readonly id: number;
}

interface ByeEvent {
  readonly type: 'bye';
  readonly id: number;
}

type ProtocolEvent = HelloEvent | PongEvent | ByeEvent;

interface ReadyEvent {
  readonly event: 'ready';
  readonly pid: number;
}

interface FirstResponseEvent {
  readonly event: 'first-response';
}

interface CompleteEvent {
  readonly event: 'complete';
  readonly warmSamplesMs: readonly number[];
}

type BenchmarkEvent = ReadyEvent | FirstResponseEvent | CompleteEvent;

interface SampleResult {
  readonly markerToReadyMs: number;
  readonly readyToFirstMs: number;
  readonly markerToFirstMs: number;
  readonly warmSamplesMs: readonly number[];
}

interface Summary {
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    child: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    samples: { type: 'string', default: '7' },
    iterations: { type: 'string', default: '10000' },
    warmup: { type: 'string', default: '100' },
  },
  strict: true,
});

const iterations = positiveInteger(values.iterations, 'iterations');
const warmup = positiveInteger(values.warmup, 'warmup');

if (values.child) {
  await runChild(warmup, iterations);
} else {
  await runParent(positiveInteger(values.samples, 'samples'), warmup, iterations, values.json);
}

async function runChild(warmupIterations: number, measuredIterations: number): Promise<void> {
  const prefix = `@pynect:${randomBytes(12).toString('base64url')} `;
  process.stdout.write(`${benchmarkStart}\n`);
  const transport = StdioPingPong.start(prefix);
  try {
    const pid = await withTimeout(transport.ready, 'Python stdio hello');
    emit({ event: 'ready', pid });

    await withTimeout(transport.ping(), 'first Python stdio pong');
    emit({ event: 'first-response' });

    for (let index = 0; index < warmupIterations; index += 1) {
      await transport.ping();
    }
    const warmSamplesMs: number[] = [];
    for (let index = 0; index < measuredIterations; index += 1) {
      const startedAt = performance.now();
      await transport.ping();
      warmSamplesMs.push(performance.now() - startedAt);
    }
    emit({ event: 'complete', warmSamplesMs });
  } finally {
    await transport.close();
  }
}

async function runParent(
  sampleCount: number,
  warmupIterations: number,
  measuredIterations: number,
  json: boolean,
): Promise<void> {
  const samples: SampleResult[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    samples.push(await runFreshProcess(warmupIterations, measuredIterations));
  }

  const warm = samples.flatMap(sample => sample.warmSamplesMs);
  const warmSummary = summarize(warm);
  const report = {
    pythonLaunchMs: summarize(samples.map(sample => sample.markerToReadyMs)),
    firstPingMs: summarize(samples.map(sample => sample.readyToFirstMs)),
    coldPingMs: summarize(samples.map(sample => sample.markerToFirstMs)),
    warmPingMs: warmSummary,
    pingsPerSecond: 1000 / warmSummary.mean,
  };

  if (json) {
    console.log(JSON.stringify({
      environment: {
        bun: Bun.version,
        platform: `${process.platform}-${process.arch}`,
        runtime: process.version,
      },
      measuredIterations,
      report,
      sampleCount,
      warmupIterations,
    }, null, 2));
    return;
  }

  console.log(`Bun ${Bun.version}; ${process.platform}-${process.arch}`);
  console.log(`${sampleCount} fresh Bun/Python processes; ${warmupIterations} warmups + ${measuredIterations} measured pings each.`);
  console.table([{
    path: 'Bun \u2194 Python prefixed stdio',
    'Python launch p50 ms': round(report.pythonLaunchMs.p50),
    'first ping p50 ms': round(report.firstPingMs.p50, 3),
    'cold ping total p50 ms': round(report.coldPingMs.p50),
    'warm p50 ms': round(report.warmPingMs.p50, 3),
    'warm p95 ms': round(report.warmPingMs.p95, 3),
    'warm p99 ms': round(report.warmPingMs.p99, 3),
    'pings/sec': Math.round(report.pingsPerSecond),
  }]);
  console.log(`Timing starts immediately before spawning ${pythonPath}; cold ping includes Python startup and one ping/pong.`);
}

async function runFreshProcess(
  warmupIterations: number,
  measuredIterations: number,
): Promise<SampleResult> {
  const child = spawn(process.execPath, [
    launcherPath,
    '--child',
    '--warmup', String(warmupIterations),
    '--iterations', String(measuredIterations),
  ], {
    cwd: packageRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  if (!child.stdout) throw new Error('stdio benchmark child stdout is unavailable.');

  let markerAt: number | undefined;
  let readyAt: number | undefined;
  let firstAt: number | undefined;
  let complete: CompleteEvent | undefined;
  let parseFailure: Error | undefined;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    if (line === benchmarkStart) {
      if (markerAt === undefined) markerAt = performance.now();
      else parseFailure = new Error('stdio benchmark emitted two start markers.');
      return;
    }
    try {
      const event = JSON.parse(line) as BenchmarkEvent;
      if (event.event === 'ready') readyAt = performance.now();
      else if (event.event === 'first-response') firstAt = performance.now();
      else if (event.event === 'complete') complete = event;
      else parseFailure = new Error(`Unknown benchmark event: ${line}`);
    } catch (error) {
      parseFailure = error instanceof Error ? error : new Error(String(error));
    }
  });

  const exitCode = await waitForExit(child);
  lines.close();
  if (exitCode !== 0) throw new Error(`stdio benchmark child exited with code ${exitCode}.`);
  if (parseFailure) throw parseFailure;
  if (markerAt === undefined || readyAt === undefined || firstAt === undefined || !complete) {
    throw new Error('stdio benchmark child did not report complete results.');
  }
  if (!(markerAt <= readyAt && readyAt <= firstAt)) {
    throw new Error('stdio benchmark events arrived out of order.');
  }
  return {
    markerToReadyMs: readyAt - markerAt,
    readyToFirstMs: firstAt - readyAt,
    markerToFirstMs: firstAt - markerAt,
    warmSamplesMs: complete.warmSamplesMs,
  };
}

class StdioPingPong {
  readonly ready: Promise<number>;
  readonly #child: ChildProcess;
  readonly #prefix: string;
  readonly #pending = new Map<number, { reject(error: Error): void; resolve(): void }>();
  readonly #exited: Promise<number | null>;
  #nextId = 1;
  #protocolEvents = 0;
  #resolveReady!: (pid: number) => void;
  #rejectReady!: (error: Error) => void;
  #settledReady = false;
  #closed = false;

  private constructor(child: ChildProcess, prefix: string) {
    this.#child = child;
    this.#prefix = prefix;
    this.ready = new Promise<number>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#exited = waitForExit(child);
    if (!child.stdout || !child.stderr || !child.stdin) {
      throw new Error('Python stdio pipes are unavailable.');
    }
    child.stderr.pipe(process.stderr, { end: false });
    new PrefixedRecordReader(
      child.stdout,
      Buffer.from(prefix),
      process.stderr,
      event => { this.#receive(event); },
      error => { this.#fail(error); },
    );
    child.once('error', error => { this.#fail(error); });
    child.once('close', (code, signal) => {
      if (!this.#closed || code !== 0) {
        this.#fail(new Error(`Python stdio worker exited with ${signal ?? `code ${code ?? 'unknown'}`}.`));
      }
    });
  }

  static start(prefix: string): StdioPingPong {
    const child = spawn(pythonPath, [workerPath], {
      cwd: exampleRoot,
      env: {
        ...process.env,
        PYNECT_STDIO_PREFIX: prefix,
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return new StdioPingPong(child, prefix);
  }

  ping(): Promise<void> {
    return this.#request('ping');
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const request = this.#request('shutdown');
    this.#child.stdin?.end();
    await withTimeout(request, 'Python stdio shutdown');
    const exitCode = await withTimeout(this.#exited, 'Python stdio process exit');
    if (exitCode !== 0) throw new Error(`Python stdio worker exited with code ${exitCode}.`);
  }

  #request(type: 'ping' | 'shutdown'): Promise<void> {
    if (!this.#child.stdin || !this.#child.stdin.writable) {
      return Promise.reject(new Error('Python stdio stdin is not writable.'));
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const response = new Promise<void>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#child.stdin.write(encodeRecord(this.#prefix, { type, id }));
    return response;
  }

  #receive(event: unknown): void {
    if (!isProtocolEvent(event)) {
      this.#fail(new Error('Python emitted an invalid stdio protocol event.'));
      return;
    }
    this.#protocolEvents += 1;
    if (this.#protocolEvents === 1) {
      if (event.type !== 'hello' || event.protocol !== 1) {
        this.#fail(new Error('The first Python stdio event was not the protocol hello.'));
        return;
      }
      this.#settledReady = true;
      this.#resolveReady(event.pid);
      return;
    }
    if (event.type === 'hello') {
      this.#fail(new Error('Python emitted more than one stdio hello event.'));
      return;
    }
    const pending = this.#pending.get(event.id);
    if (!pending) {
      this.#fail(new Error(`Python replied to unknown request ${event.id}.`));
      return;
    }
    this.#pending.delete(event.id);
    pending.resolve();
  }

  #fail(error: Error): void {
    if (!this.#settledReady) {
      this.#settledReady = true;
      this.#rejectReady(error);
    }
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

class PrefixedRecordReader {
  readonly #parser: StdioOutputParser;

  constructor(
    input: Readable,
    prefix: Buffer,
    passthrough: Writable,
    onEvent: (event: unknown) => void,
    onError: (error: Error) => void,
  ) {
    this.#parser = new StdioOutputParser({
      prefix: prefix.toString(),
      onEvent,
      onOutput: output => { passthrough.write(output); },
      onProtocolError: onError,
    });
    input.on('data', (chunk: Buffer | string) => {
      this.#parser.push(chunk);
    });
    input.once('end', () => { this.#parser.finish(); });
    input.once('error', error => { onError(error); });
  }
}

function encodeRecord(prefix: string, event: object): Buffer {
  const payload = Buffer.from(JSON.stringify(event));
  return Buffer.concat([Buffer.from(`${prefix}${payload.length}:`), payload]);
}

function isProtocolEvent(event: unknown): event is ProtocolEvent {
  if (!event || typeof event !== 'object') return false;
  const candidate = event as { id?: unknown; pid?: unknown; protocol?: unknown; type?: unknown };
  if (candidate.type === 'hello') {
    return Number.isSafeInteger(candidate.pid) && Number.isSafeInteger(candidate.protocol);
  }
  return (candidate.type === 'pong' || candidate.type === 'bye')
    && Number.isSafeInteger(candidate.id);
}

function emit(event: BenchmarkEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => { resolve(code); });
  });
}

function withTimeout<T>(promise: Promise<T>, purpose: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${purpose} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    timer.unref();
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
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
