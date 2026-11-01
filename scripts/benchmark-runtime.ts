import { lstat, mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command, Option } from 'commander';
import { runBun, runCommand } from './command.ts';

type BenchmarkSuite =
  | 'docker-full'
  | 'docker-system-python'
  | 'docker-uv-only'
  | 'docker-zero'
  | 'windows';

interface BenchmarkRequest {
  cacheDir: string;
  managedPython?: string;
  projectRoot: string;
  requiresPython?: string;
  dependencies?: string[];
  verifyModules?: string[];
}

interface WorkerResult {
  apiMs: number;
  environment: {
    managed: boolean;
    pythonSource: 'cache' | 'external';
    pythonVersion: string;
    uvSource: 'cache' | 'external';
    uvVersion: string;
    virtualEnvironment: string;
  };
  verificationMs: number;
}

interface Measurement extends WorkerResult {
  wallMs: number;
}

interface SnapshotEntry {
  bytes: number;
  modifiedMs: number;
  type: 'directory' | 'file' | 'link';
}

type Snapshot = Map<string, SnapshotEntry>;

interface ScenarioDefinition {
  description: string;
  kind: 'empty' | 'existing-root-venv' | 'seed-private-venv';
  managedPython?: string;
  name: string;
  requiresPython?: string;
  dependencies?: string[];
  uv: 'existing' | 'missing';
  verifyModules?: string[];
}

const program = new Command()
  .name('benchmark-runtime')
  .addOption(new Option('--suite <suite>').choices([
    'docker-full',
    'docker-system-python',
    'docker-uv-only',
    'docker-zero',
    'windows',
  ]).makeOptionMandatory())
  .option('--scenario <name>', 'run only one named scenario')
  .option('--warm-runs <count>', 'warm process count', parsePositiveInteger, 3)
  .option('--keep', 'preserve the temporary benchmark directory')
  .parse();

const cli = program.opts<{
  keep?: boolean;
  scenario?: string;
  suite: BenchmarkSuite;
  warmRuns: number;
}>();
const suiteRoot = await mkdtemp(path.join(os.tmpdir(), `pyfig-benchmark-${cli.suite}-`));

try {
  const scenarios = [];
  const definitions = definitionsFor(cli.suite)
    .filter((definition) => !cli.scenario || definition.name === cli.scenario);
  if (definitions.length === 0) {
    throw new Error(`Unknown scenario ${JSON.stringify(cli.scenario)} for ${cli.suite}.`);
  }
  for (const definition of definitions) {
    process.stderr.write(`Benchmarking ${definition.name}...\n`);
    scenarios.push(await benchmarkScenario(definition, cli.warmRuns, suiteRoot));
  }
  process.stdout.write(`${JSON.stringify({
    generatedAt: new Date().toISOString(),
    host: {
      architecture: process.arch,
      bunVersion: Bun.version,
      cpus: os.cpus().length,
      memoryBytes: os.totalmem(),
      platform: process.platform,
      release: os.release(),
    },
    scenarios,
    suite: cli.suite,
    warmRuns: cli.warmRuns,
  }, null, 2)}\n`);
} finally {
  if (cli.keep) process.stderr.write(`Preserved benchmark data at ${suiteRoot}\n`);
  else await rm(suiteRoot, { recursive: true, force: true });
}

async function benchmarkScenario(
  definition: ScenarioDefinition,
  warmRuns: number,
  suiteRoot: string,
): Promise<object> {
  const scenarioRoot = path.join(suiteRoot, definition.name);
  const projectRoot = path.join(scenarioRoot, 'project');
  const cacheDir = path.join(scenarioRoot, 'cache');
  await mkdir(projectRoot, { recursive: true });

  const request: BenchmarkRequest = {
    cacheDir,
    managedPython: definition.managedPython,
    projectRoot,
    requiresPython: definition.requiresPython,
    dependencies: definition.dependencies,
    verifyModules: definition.verifyModules,
  };
  const childEnvironment = {
    ...process.env,
    PYFIG_UV: definition.uv === 'missing'
      ? path.join(scenarioRoot, 'unavailable-uv')
      : process.env['PYFIG_BENCHMARK_UV'] ?? 'uv',
  };

  let setup: Measurement | { wallMs: number } | null = null;
  if (definition.kind === 'existing-root-venv') {
    const started = performance.now();
    runCommand(
      process.env['PYFIG_BENCHMARK_UV'] ?? 'uv',
      [
        'venv', '--no-project', '--no-config', '--no-python-downloads',
        '--python-preference', 'system', path.join(projectRoot, '.venv'),
      ],
      { capture: true, env: childEnvironment },
    );
    setup = { wallMs: performance.now() - started };
  } else if (definition.kind === 'seed-private-venv') {
    setup = runWorker({ ...request, dependencies: [], verifyModules: [] }, childEnvironment);
  }

  const projectBefore = await snapshot(projectRoot);
  const cacheBefore = await snapshot(cacheDir);
  const cold = runWorker(request, childEnvironment);
  const projectAfterCold = await snapshot(projectRoot);
  const cacheAfterCold = await snapshot(cacheDir);

  const warm: Measurement[] = [];
  for (let index = 0; index < warmRuns; index += 1) {
    warm.push(runWorker(request, childEnvironment));
  }
  const projectAfterWarm = await snapshot(projectRoot);
  const cacheAfterWarm = await snapshot(cacheDir);

  return {
    cold,
    description: definition.description,
    final: {
      cache: summarize(cacheAfterWarm),
      project: summarize(projectAfterWarm),
    },
    mutations: {
      coldCache: compare(cacheBefore, cacheAfterCold),
      coldProject: compare(projectBefore, projectAfterCold),
      warmCache: compare(cacheAfterCold, cacheAfterWarm),
      warmProject: compare(projectAfterCold, projectAfterWarm),
    },
    name: definition.name,
    setup,
    warm: {
      apiMs: statistics(warm.map((sample) => sample.apiMs)),
      samples: warm,
      wallMs: statistics(warm.map((sample) => sample.wallMs)),
    },
  };
}

function runWorker(
  request: BenchmarkRequest,
  env: NodeJS.ProcessEnv,
): Measurement {
  const started = performance.now();
  const output = runBun(
    ['run', path.join(import.meta.dir, 'benchmark-worker.ts')],
    {
      capture: true,
      env: {
        ...env,
        PYFIG_BENCHMARK_REQUEST: JSON.stringify(request),
      },
    },
  );
  return {
    ...JSON.parse(output) as WorkerResult,
    wallMs: performance.now() - started,
  };
}

async function snapshot(root: string): Promise<Snapshot> {
  const entries: Snapshot = new Map();
  const pending = [''];
  while (pending.length > 0) {
    const relativeDirectory = pending.pop() as string;
    const directory = path.join(root, relativeDirectory);
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      const relative = path.join(relativeDirectory, child.name);
      const target = path.join(root, relative);
      const information = await lstat(target);
      const type = child.isDirectory() ? 'directory' : child.isSymbolicLink() ? 'link' : 'file';
      entries.set(relative, {
        bytes: type === 'file' ? information.size : 0,
        modifiedMs: information.mtimeMs,
        type,
      });
      if (type === 'directory') pending.push(relative);
    }
  }
  return entries;
}

function summarize(snapshot: Snapshot): object {
  const values = [...snapshot.values()];
  return {
    bytes: values.reduce((total, entry) => total + entry.bytes, 0),
    directories: values.filter((entry) => entry.type === 'directory').length,
    files: values.filter((entry) => entry.type === 'file').length,
    links: values.filter((entry) => entry.type === 'link').length,
    topLevel: [...new Set([...snapshot.keys()].map((entry) => entry.split(path.sep)[0]))]
      .filter(Boolean)
      .sort(),
  };
}

function compare(before: Snapshot, after: Snapshot): object {
  const created = [...after.keys()].filter((key) => !before.has(key));
  const removed = [...before.keys()].filter((key) => !after.has(key));
  const modified = [...after.entries()].filter(([key, value]) => {
    const previous = before.get(key);
    return previous && (
      previous.bytes !== value.bytes ||
      previous.modifiedMs !== value.modifiedMs ||
      previous.type !== value.type
    );
  }).map(([key]) => key);
  return {
    created: created.length,
    createdBytes: created.reduce((total, key) => total + (after.get(key)?.bytes ?? 0), 0),
    createdExamples: examples(created),
    createdTopLevel: [...new Set(created.map((entry) => entry.split(path.sep)[0]))]
      .filter(Boolean)
      .sort(),
    modified: modified.length,
    modifiedExamples: examples(modified),
    removed: removed.length,
    removedExamples: examples(removed),
  };
}

function examples(entries: string[]): string[] {
  return entries.slice(0, 12).map((entry) => entry.split(path.sep).join('/'));
}

function statistics(values: number[]): object {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : sorted[middle] as number;
  return {
    maximum: Math.max(...values),
    median,
    minimum: Math.min(...values),
  };
}

function definitionsFor(suite: BenchmarkSuite): ScenarioDefinition[] {
  const newVenv = (uv: 'existing' | 'missing', name: string): ScenarioDefinition => ({
    description: 'Empty project; prepare a private venv without runtime dependencies.',
    kind: 'empty',
    name,
    uv,
  });
  const addDependency = (uv: 'existing' | 'missing', name: string): ScenarioDefinition => ({
    description: 'Private venv is seeded outside timing; install idna, then repeat the same request.',
    kind: 'seed-private-venv',
    name,
    dependencies: ['idna==3.10'],
    uv,
    verifyModules: ['idna'],
  });
  if (suite === 'windows') {
    return [
      newVenv('existing', 'existing-uv-new-venv'),
      newVenv('missing', 'missing-uv-system-python'),
      {
        description: 'A root .venv is created outside timing and reused; first launch may write bytecode.',
        kind: 'existing-root-venv',
        name: 'reuse-root-venv',
        uv: 'existing',
      },
      addDependency('existing', 'add-dependency-private-venv'),
      {
        description: 'No matching system interpreter; download managed Python and create a venv.',
        kind: 'empty',
        managedPython: '3.12',
        name: 'managed-python-fallback',
        requiresPython: '>=3.12,<3.13',
        uv: 'existing',
      },
    ];
  }
  if (suite === 'docker-zero') {
    return [
      newVenv('missing', 'zero-python-zero-uv'),
      addDependency('missing', 'add-dependency-after-bootstrap'),
    ];
  }
  if (suite === 'docker-system-python') {
    return [
      newVenv('missing', 'missing-uv-system-python'),
      addDependency('missing', 'add-dependency-after-bootstrap'),
    ];
  }
  if (suite === 'docker-uv-only') {
    return [
      newVenv('existing', 'existing-uv-managed-python'),
      addDependency('existing', 'add-dependency-after-bootstrap'),
    ];
  }
  return [
    newVenv('existing', 'existing-uv-system-python'),
    {
      description: 'A root .venv is created outside timing and reused; first launch may write bytecode.',
      kind: 'existing-root-venv',
      name: 'reuse-root-venv',
      uv: 'existing',
    },
    addDependency('existing', 'add-dependency-private-venv'),
  ];
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('expected a positive integer');
  return parsed;
}
