import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateBindings, setupDevelopment } from '../src/js/codegen';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('Python code generation', () => {
  test('generates typed bindings from Node-owned options', async () => {
    const outputDirectory = mkdtempSync(path.join(tmpdir(), 'pynect-codegen-'));
    temporaryDirectories.push(outputDirectory);
    const output = path.join(outputDirectory, 'fixture-python.ts');
    const result = await generateBindings({
      root: process.cwd(),
      module: [
        'fixture=tests.fixtures.bridge_fixture',
        'one=tests.fixtures.one.shared.name_generator',
        'two=tests.fixtures.two.shared.name_generator',
      ],
      className: 'FixturePython',
      project: false,
      out: output,
    });

    expect(result).toBe(output);
    const generated = readFileSync(output, 'utf8');
    expect(generated).toContain('export interface FixtureModule');
    expect(generated).toContain('readonly call_callback:');
    expect(generated).toContain('export interface BridgeRow {');
    expect(generated).toContain('export class FixturePython implements AsyncDisposable');
  }, 30_000);

  test('reads pyproject configuration in Node', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'pynect-project-'));
    temporaryDirectories.push(projectRoot);
    writeFileSync(path.join(projectRoot, 'demo.py'), 'def greet(name: str) -> str:\n    return f"Hello {name}"\n');
    writeFileSync(path.join(projectRoot, 'pyproject.toml'), `
[project]
name = "fixture"
version = "0.1.0"

[tool.pynect.codegen]
modules = ["demo"]
project = false
out = "generated/demo-python.ts"
callTimeoutMs = 5000
`.trimStart());

    const output = await generateBindings({ root: projectRoot });
    expect(output).toBe(path.join(projectRoot, 'generated', 'demo-python.ts'));
    expect(readFileSync(output, 'utf8')).toContain('"callTimeoutMs": 5000');
  }, 30_000);

  test('sets up an idempotent Node-based editor workflow', () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'pynect-setup-'));
    temporaryDirectories.push(projectRoot);

    expect(setupDevelopment({ root: projectRoot, dryRun: true })[0]).toContain('Would update');
    expect(existsSync(path.join(projectRoot, '.vscode', 'settings.json'))).toBe(false);
    expect(setupDevelopment({ root: projectRoot })[0]).toContain('Updated');
    const settings = JSON.parse(
      readFileSync(path.join(projectRoot, '.vscode', 'settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    const commands = settings['runOnSave.commands'] as Array<Record<string, unknown>>;
    expect(commands[0]?.command).toBe('pynect codegen generate');
    expect(setupDevelopment({ root: projectRoot })).toEqual([
      'Development setup is already current',
    ]);
  });
});
