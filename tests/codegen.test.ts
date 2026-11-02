import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensurePython } from 'pyfig';

const temporaryDirectories: string[] = [];

async function runCodegen(arguments_: string[]) {
  const environment = await ensurePython({ projectRoot: process.cwd() });
  return spawnSync(environment.python.executable, [
    path.resolve('python/pynect_codegen.py'),
    ...arguments_,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
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
  }, 30_000);
});
