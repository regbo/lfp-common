import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProject } from '../src/config.js';
import type { PynectClientOptions, PynectPyfigOptions } from '../src/index.js';
import { workerOptionsSchema } from '../src/worker.js';

const temporaryDirectories: string[] = [];

test('exposes only supported generation, client, configuration, and worker APIs', async () => {
  const api = await import('../src/index.js');
  expect(Object.keys(api).sort()).toEqual([
    'Worker',
    'createPynectClient',
    'generateProject',
    'projectOptionsSchema',
    'pynectPyfigOptionsSchema',
    'pynectPythonSchema',
    'resolveProject',
    'startWorker',
    'workerOptionsSchema',
  ]);
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('project configuration', () => {
  test('defers omitted Python to project configuration and Pyfig defaults', () => {
    const options = workerOptionsSchema.parse({});

    expect(options.python).toBeUndefined();
    expect({ uv: '>=0.10,<1' } satisfies PynectPyfigOptions).toEqual({ uv: '>=0.10,<1' });
    expect({ baseUrl: 'ws://localhost' } satisfies PynectClientOptions).toEqual({
      baseUrl: 'ws://localhost',
    });
  });

  test('accepts native Pyfig runtime options without code-generation fields', () => {
    const options = workerOptionsSchema.parse({
      name: 'ignored-at-runtime',
      out: 'ignored-at-runtime',
      python: {
        debug: true,
        python: '3.12',
        uv: '>=0.10,<1',
      },
    });

    expect(options.python).toEqual({
      debug: true,
      python: '3.12',
      uv: '>=0.10,<1',
    });
    expect(options).not.toHaveProperty('name');
    expect(options).not.toHaveProperty('out');
  });

  test('derives the generated folder and project identity from pyproject.toml', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pynect-config-'));
    temporaryDirectories.push(root);
    writeFileSync(path.join(root, 'pyproject.toml'), `
[project]
name = "Model Catalog"
version = "0.1.0"

[tool.pynect]
app = "catalog.server:app"
python = { python = ">=3.12", uv = ">=0.10,<1", debug = true }
validation = "zod"
`.trimStart());

    const project = resolveProject(workerOptionsSchema.parse({ root }));

    expect(project.app).toBe('catalog.server:app');
    expect(project.slug).toBe('model-catalog');
    expect(project.outDir).toBe(path.join(root, '_generated', 'model-catalog'));
    expect(project.schemaPath).toBe(path.join(project.outDir, 'asyncapi.json'));
    expect(project.python).toEqual({
      debug: true,
      python: '>=3.12',
      uv: '>=0.10,<1',
    });
    expect(project.validation).toBe('zod');
  });

  test('direct options override tool configuration', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pynect-config-'));
    temporaryDirectories.push(root);
    writeFileSync(path.join(root, 'pyproject.toml'), `
[project]
name = "catalog"
version = "0.1.0"

[tool.pynect]
app = "server:app"
out = "generated"
`.trimStart());

    const project = resolveProject({
      root,
      app: 'other:application',
      out: '../client/_generated/catalog',
      python: '/test/python',
    });

    expect(project.app).toBe('other:application');
    expect(project.outDir).toBe(path.resolve(root, '../client/_generated/catalog'));
    expect(project.python).toBe('/test/python');
  });
});
