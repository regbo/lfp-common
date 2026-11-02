import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensurePython } from 'pyfig';

const temporaryDirectories: string[] = [];

async function runCodegen(
  arguments_: string[],
  script = path.resolve('python/pynect_codegen.py'),
  environmentOverrides: NodeJS.ProcessEnv = {},
) {
  const environment = await ensurePython({ projectRoot: process.cwd() });
  return spawnSync(environment.uv.executable, [
    'run',
    '--quiet',
    '--script',
    script,
    ...arguments_,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...environmentOverrides },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('Python code generation', () => {
  test('generates typed bindings without invoking a JavaScript runtime', async () => {
    const outputDirectory = mkdtempSync(path.join(tmpdir(), 'pynect-codegen-'));
    temporaryDirectories.push(outputDirectory);
    const output = path.join(outputDirectory, 'fixture-python.ts');
    const result = await runCodegen([
      'generate',
      '--module',
      'fixture=tests.fixtures.bridge_fixture',
      '--module',
      'tests.fixtures.one.shared.name_generator',
      '--module',
      'tests.fixtures.two.shared.name_generator',
      '--class-name',
      'FixturePython',
      '--no-project',
      '--out',
      output,
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const generated = readFileSync(output, 'utf8');
    expect(generated).toContain('export interface FixtureModule');
    expect(generated).toContain('export interface OneSharedNameGeneratorModule');
    expect(generated).toContain('export interface TwoSharedNameGeneratorModule');
    expect(generated).toContain(
      '"one_shared_name_generator": "tests.fixtures.one.shared.name_generator"',
    );
    expect(generated).toContain(
      '"two_shared_name_generator": "tests.fixtures.two.shared.name_generator"',
    );
    expect(generated).toContain('readonly add: (left: unknown, right: unknown): Promise<unknown>');
    expect(generated).toContain('export class FixturePython implements AsyncDisposable');
    expect(generated).toContain('modules: { ...defaults.modules, ...options.modules }');
  }, 30_000);

  test('derives a class name for one module and requires one for multiple modules', async () => {
    const outputDirectory = mkdtempSync(path.join(tmpdir(), 'pynect-codegen-name-'));
    temporaryDirectories.push(outputDirectory);
    const output = path.join(outputDirectory, 'bridge-fixture-python.ts');
    const singleModule = await runCodegen([
      'generate',
      '--module',
      'tests.fixtures.bridge_fixture',
      '--no-project',
      '--out',
      output,
    ]);

    expect(singleModule.status).toBe(0);
    expect(readFileSync(output, 'utf8')).toContain(
      'export class BridgeFixturePython implements AsyncDisposable',
    );

    const multipleModules = await runCodegen([
      'generate',
      '--module',
      'tests.fixtures.bridge_fixture',
      '--module',
      'tests.fixtures.one.shared.name_generator',
      '--no-project',
      '--out',
      output,
    ]);

    expect(multipleModules.status).not.toBe(0);
    expect(multipleModules.stderr).toContain(
      '--class-name or className is required when generating multiple modules',
    );
  }, 120_000);

  test('sets up an idempotent VS Code workflow and Hatch build hook', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'pynect-python-project-'));
    temporaryDirectories.push(projectRoot);
    writeFileSync(path.join(projectRoot, 'demo.py'), 'def greet(name: str) -> str:\n    return f"Hello {name}"\n');
    writeFileSync(path.join(projectRoot, 'pyproject.toml'), `
[project]
name = "pynect-codegen-fixture"
version = "0.1.0"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.pynect.codegen]
modules = ["demo"]
project = false
out = "generated/demo-python.ts"
with = ["httpx>=0.28"]
withEditable = ["../shared-python"]
withRequirements = ["requirements.txt"]
uvArgs = ["--offline"]
validatePydantic = false
autoClose = false
startupTimeoutMs = 30000
callTimeoutMs = 5000
`.trimStart());

    const dryRun = await runCodegen([
      'setup-dev',
      '--root',
      projectRoot,
      '--dry-run',
    ]);
    const installedScript = path.join(projectRoot, 'scripts', 'pynect_codegen.py');
    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout).toContain('Would update');
    expect(dryRun.stdout).toContain('pynect_codegen.py');
    expect(existsSync(installedScript)).toBe(false);

    const setup = await runCodegen(['setup-dev', '--root', projectRoot]);
    expect(setup.status).toBe(0);
    expect(existsSync(installedScript)).toBe(true);
    const settings = JSON.parse(
      readFileSync(path.join(projectRoot, '.vscode', 'settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(settings['runOnSave.ignoreFilesBy']).toEqual(['.gitignore']);
    const commands = settings['runOnSave.commands'] as Array<Record<string, unknown>>;
    expect(commands[0]?.['command']).toBe(
      'uv run --script "scripts/pynect_codegen.py" generate',
    );
    expect(
      readFileSync(path.join(projectRoot, '.vscode', 'extensions.json'), 'utf8'),
    ).toContain('pucelle.run-on-save');
    expect(readFileSync(path.join(projectRoot, 'pyproject.toml'), 'utf8')).toContain(
      'path = "scripts/pynect_codegen.py"',
    );

    const repeatedSetup = await runCodegen(['setup-dev', '--root', projectRoot]);
    expect(repeatedSetup.status).toBe(0);
    expect(repeatedSetup.stdout).toContain('Development setup is already current');

    const generate = await runCodegen(
      ['generate', '--root', projectRoot],
      installedScript,
    );
    expect(generate.status).toBe(0);
    const generated = readFileSync(
      path.join(projectRoot, 'generated', 'demo-python.ts'),
      'utf8',
    );
    expect(generated).toContain('export class DemoPython implements AsyncDisposable');
    expect(generated).toContain('"withEditable": [');
    expect(generated).toContain('"validatePydantic": false');
    expect(generated).toContain('"callTimeoutMs": 5000');

    const precedence = await runCodegen(
      [
        'generate',
        '--root',
        projectRoot,
        '--class-name',
        'CliDemoPython',
        '--out',
        'generated/precedence.ts',
      ],
      installedScript,
      { PYNECT_CODEGEN_CLASS_NAME: 'EnvironmentDemoPython' },
    );
    expect(precedence.status).toBe(0);
    expect(
      readFileSync(path.join(projectRoot, 'generated', 'precedence.ts'), 'utf8'),
    ).toContain('export class CliDemoPython implements AsyncDisposable');
  }, 120_000);
});
