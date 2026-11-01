import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createPyEnvironment,
  type PyEnvironmentClient,
} from '../src/index.ts';

const INITIAL_URLLIB3 = '2.8.0';
const DOWNGRADED_URLLIB3 = '2.0.7';
const BOTOCORE = '1.34.0';
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'pyfig-dependency-probe-'));
const cacheDir = path.join(temporaryRoot, 'cache');

try {
  const isolated = await compatibleIsolation();
  const rejected = await rejectedConflict();
  const raw = await rawPipConflict();
  process.stdout.write(`${JSON.stringify({
    generatedAt: new Date().toISOString(),
    isolated,
    raw,
    rejected,
  }, null, 2)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function compatibleIsolation(): Promise<object> {
  const project = await createProject('compatible-isolation', 'urllib3>=1.25.4,<3');
  const baselinePyenv = project.createPyenv([`urllib3==${INITIAL_URLLIB3}`, 'idna==3.10']);
  const botocorePyenv = project.createPyenv([`botocore==${BOTOCORE}`, 'idna==3.10']);
  const baselineEnvironment = await baselinePyenv.prepare();
  const started = performance.now();
  const botocoreEnvironment = await botocorePyenv.prepare();
  const elapsedMs = performance.now() - started;
  const baseline = await environmentState(baselinePyenv);
  const botocore = await environmentState(botocorePyenv);

  assert(baseline.urllib3 === INITIAL_URLLIB3, 'baseline urllib3 changed');
  assert(botocore.urllib3 === DOWNGRADED_URLLIB3, `expected urllib3 ${DOWNGRADED_URLLIB3}`);
  assert(botocore.botocore === BOTOCORE, `expected botocore ${BOTOCORE}`);
  assert(botocore.idna === '3.10', 'botocore environment lost idna');
  assert(
    baselineEnvironment.venvId !== botocoreEnvironment.venvId,
    'different resolutions shared one environment',
  );
  assert(
    await readFile(path.join(project.projectRoot, 'pyproject.toml'), 'utf8') === project.pyproject,
    'pyproject changed',
  );
  return {
    baseline,
    botocore,
    elapsedMs,
    environmentsIsolated: true,
    projectFileChanged: false,
  };
}

async function rejectedConflict(): Promise<object> {
  const project = await createProject('rejected-conflict', 'urllib3>=2.2,<3');
  const baselinePyenv = project.createPyenv([`urllib3==${INITIAL_URLLIB3}`, 'idna==3.10']);
  const conflictingPyenv = project.createPyenv([`botocore==${BOTOCORE}`]);
  await baselinePyenv.prepare();
  const before = await environmentState(baselinePyenv);
  const started = performance.now();
  let error = '';
  try {
    await conflictingPyenv.prepare();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const elapsedMs = performance.now() - started;
  const after = await environmentState(baselinePyenv);
  assert(error.length > 0, 'expected dependency resolution to fail');
  assert(before.urllib3 === INITIAL_URLLIB3 && after.urllib3 === INITIAL_URLLIB3, 'baseline changed');
  assert(before.idna === '3.10' && after.idna === '3.10', 'baseline idna changed');
  assert(after.botocore === null, 'conflict leaked into the baseline environment');
  assert(
    await readFile(path.join(project.projectRoot, 'pyproject.toml'), 'utf8') === project.pyproject,
    'pyproject changed',
  );
  return {
    after,
    before,
    elapsedMs,
    environmentChanged: false,
    error: firstUsefulLine(error),
    projectFileChanged: false,
  };
}

async function rawPipConflict(): Promise<object> {
  const project = await createProject('raw-pip-conflict', 'urllib3>=2.2,<3');
  const pyenv = project.createPyenv([`urllib3==${INITIAL_URLLIB3}`, 'idna==3.10']);
  await pyenv.prepare();
  const before = await environmentState(pyenv);
  const started = performance.now();
  const result = pyenv.uvSync(
    ['pip', 'install', `botocore==${BOTOCORE}`],
    { encoding: 'utf8' },
  );
  const elapsedMs = performance.now() - started;
  assert(result.status === 0, String(result.stderr || `raw install exited ${result.status}`));
  const after = await environmentState(pyenv);
  const pipCheck = pyenv.uvSync(['pip', 'check'], { encoding: 'utf8' });
  assert(after.urllib3 === DOWNGRADED_URLLIB3, 'raw pip install did not downgrade urllib3');
  assert(after.botocore === BOTOCORE, 'raw pip install did not add botocore');
  assert(after.idna === '3.10', 'raw pip install removed unrelated idna');
  assert(pipCheck.status === 0, String(pipCheck.stderr || `pip check exited ${pipCheck.status}`));
  assert(
    await readFile(path.join(project.projectRoot, 'pyproject.toml'), 'utf8') === project.pyproject,
    'pyproject changed',
  );
  return {
    after,
    before,
    elapsedMs,
    pipCheckPassed: true,
    projectConstraintSatisfied: false,
    projectFileChanged: false,
  };
}

async function createProject(
  name: string,
  urllib3Range: string,
): Promise<{
  createPyenv: (dependencies: readonly string[]) => PyEnvironmentClient;
  projectRoot: string;
  pyproject: string;
}> {
  const projectRoot = path.join(temporaryRoot, name);
  await mkdir(projectRoot, { recursive: true });
  const pyproject = [
    '[project]',
    `name = "${name}"`,
    'version = "0.0.0"',
    'requires-python = ">=3.10"',
    `dependencies = ["${urllib3Range}"]`,
    '',
  ].join('\n');
  await writeFile(path.join(projectRoot, 'pyproject.toml'), pyproject, 'utf8');
  return {
    createPyenv: (dependencies) => createPyEnvironment({ cacheDir, dependencies, projectRoot }),
    projectRoot,
    pyproject,
  };
}

async function environmentState(pyenv: PyEnvironmentClient): Promise<{
  botocore: string | null;
  idna: string | null;
  python: string;
  urllib3: string | null;
  uv: string;
}> {
  const environment = await pyenv.prepare();
  return {
    botocore: installedVersion(pyenv, 'botocore'),
    idna: installedVersion(pyenv, 'idna'),
    python: environment.python.version,
    urllib3: installedVersion(pyenv, 'urllib3'),
    uv: environment.uv.version,
  };
}

function installedVersion(pyenv: PyEnvironmentClient, distribution: string): string | null {
  const script = [
    'import importlib.metadata as metadata',
    `name = ${JSON.stringify(distribution)}`,
    'try:',
    '    print(metadata.version(name))',
    'except metadata.PackageNotFoundError:',
    '    print("<missing>")',
  ].join('\n');
  const output = uvOutput(pyenv, ['run', '--', 'python', '-c', script]);
  return output === '<missing>' ? null : output;
}

function uvOutput(pyenv: PyEnvironmentClient, args: string[]): string {
  const result = pyenv.uvSync(args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || `${args.slice(0, 2).join(' ')} exited ${result.status}`));
  }
  return String(result.stdout).trim();
}

function firstUsefulLine(message: string): string {
  return message.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? message;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
