import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPyfig, type PyfigClient } from '../src/index.ts';

const INITIAL_URLLIB3 = '2.8.0';
const DOWNGRADED_URLLIB3 = '2.0.7';
const BOTOCORE = '1.34.0';
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'pyfig-dependency-probe-'));
const cacheDir = path.join(temporaryRoot, 'cache');

try {
  const compatible = await compatibleDowngrade();
  const rejected = await rejectedConflict();
  const raw = await rawPipConflict();
  process.stdout.write(`${JSON.stringify({
    compatible,
    generatedAt: new Date().toISOString(),
    raw,
    rejected,
  }, null, 2)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function compatibleDowngrade(): Promise<object> {
  const { client, projectRoot, pyproject } = await createProject(
    'compatible-downgrade',
    'urllib3>=1.25.4,<3',
  );
  await client.prepare([`urllib3==${INITIAL_URLLIB3}`, 'idna==3.10']);
  const before = await environmentState(client);
  const started = performance.now();
  await client.prepare([`botocore==${BOTOCORE}`]);
  const elapsedMs = performance.now() - started;
  const after = await environmentState(client);
  assert(before.urllib3 === INITIAL_URLLIB3, `expected urllib3 ${INITIAL_URLLIB3} before downgrade`);
  assert(after.urllib3 === DOWNGRADED_URLLIB3, `expected urllib3 ${DOWNGRADED_URLLIB3} after downgrade`);
  assert(after.botocore === BOTOCORE, `expected botocore ${BOTOCORE}`);
  assert(after.idna === '3.10', 'unrelated idna package was not preserved');
  assert(await readFile(path.join(projectRoot, 'pyproject.toml'), 'utf8') === pyproject, 'pyproject changed');
  return { after, before, elapsedMs, projectFileChanged: false };
}

async function rejectedConflict(): Promise<object> {
  const { client, projectRoot, pyproject } = await createProject(
    'rejected-conflict',
    'urllib3>=2.2,<3',
  );
  await client.prepare([`urllib3==${INITIAL_URLLIB3}`, 'idna==3.10']);
  const before = await environmentState(client);
  const freezeBefore = uvOutput(client, ['pip', 'freeze']);
  const started = performance.now();
  let error = '';
  try {
    await client.prepare([`botocore==${BOTOCORE}`]);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const elapsedMs = performance.now() - started;
  const after = await environmentState(client);
  const freezeAfter = uvOutput(client, ['pip', 'freeze']);
  assert(error.length > 0, 'expected dependency resolution to fail');
  assert(before.urllib3 === INITIAL_URLLIB3 && after.urllib3 === INITIAL_URLLIB3, 'urllib3 changed after rejection');
  assert(before.idna === '3.10' && after.idna === '3.10', 'idna changed after rejection');
  assert(after.botocore === null, 'botocore was partially installed after rejection');
  assert(freezeAfter === freezeBefore, 'the environment changed after rejected resolution');
  assert(await readFile(path.join(projectRoot, 'pyproject.toml'), 'utf8') === pyproject, 'pyproject changed');
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
  const { client, projectRoot, pyproject } = await createProject(
    'raw-pip-conflict',
    'urllib3>=2.2,<3',
  );
  await client.prepare([`urllib3==${INITIAL_URLLIB3}`, 'idna==3.10']);
  const before = await environmentState(client);
  const started = performance.now();
  const result = client.uvSync(
    ['pip', 'install', `botocore==${BOTOCORE}`],
    { encoding: 'utf8' },
  );
  const elapsedMs = performance.now() - started;
  assert(result.status === 0, String(result.stderr || `raw install exited ${result.status}`));
  const after = await environmentState(client);
  const pipCheck = client.uvSync(['pip', 'check'], { encoding: 'utf8' });
  assert(after.urllib3 === DOWNGRADED_URLLIB3, 'raw pip install did not downgrade urllib3');
  assert(after.botocore === BOTOCORE, 'raw pip install did not add botocore');
  assert(after.idna === '3.10', 'raw pip install removed unrelated idna');
  assert(pipCheck.status === 0, String(pipCheck.stderr || `pip check exited ${pipCheck.status}`));
  assert(await readFile(path.join(projectRoot, 'pyproject.toml'), 'utf8') === pyproject, 'pyproject changed');
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
): Promise<{ client: PyfigClient; projectRoot: string; pyproject: string }> {
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
    client: createPyfig({ cacheDir, projectRoot }),
    projectRoot,
    pyproject,
  };
}

async function environmentState(client: PyfigClient): Promise<{
  botocore: string | null;
  idna: string | null;
  python: string;
  urllib3: string | null;
  uv: string;
}> {
  const environment = await client.prepare();
  return {
    botocore: installedVersion(client, 'botocore'),
    idna: installedVersion(client, 'idna'),
    python: environment.python.version,
    urllib3: installedVersion(client, 'urllib3'),
    uv: environment.uv.version,
  };
}

function installedVersion(client: PyfigClient, distribution: string): string | null {
  const script = [
    'import importlib.metadata as metadata',
    `name = ${JSON.stringify(distribution)}`,
    'try:',
    '    print(metadata.version(name))',
    'except metadata.PackageNotFoundError:',
    '    print("<missing>")',
  ].join('\n');
  const output = uvOutput(client, ['run', '--', 'python', '-c', script]);
  return output === '<missing>' ? null : output;
}

function uvOutput(client: PyfigClient, args: string[]): string {
  const result = client.uvSync(args, { encoding: 'utf8' });
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
