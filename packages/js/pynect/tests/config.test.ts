import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProject } from '../src/config.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('project configuration', () => {
  test('derives the generated folder and project identity from pyproject.toml', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pynect-config-'));
    temporaryDirectories.push(root);
    writeFileSync(path.join(root, 'pyproject.toml'), `
[project]
name = "Model Catalog"
version = "0.1.0"

[tool.pynect]
app = "catalog.server:app"
validation = "zod"
`.trimStart());

    const project = resolveProject({ root });

    expect(project.app).toBe('catalog.server:app');
    expect(project.slug).toBe('model-catalog');
    expect(project.outDir).toBe(path.join(root, '_generated', 'model-catalog'));
    expect(project.schemaPath).toBe(path.join(project.outDir, 'asyncapi.json'));
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
    });

    expect(project.app).toBe('other:application');
    expect(project.outDir).toBe(path.resolve(root, '../client/_generated/catalog'));
  });
});
