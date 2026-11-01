import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveProjectConfig } from '../src/config/project';
import {
  createProjectPlan,
  discoverPynectContributions,
  moduleDispatcherIncludes,
  validateProjectEnvironment,
} from '../src/env/ProjectEnvironment';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('project configuration', () => {
  test('uses API, environment, package.json, then defaults', () => {
    const root = project({
      name: 'example-app',
      version: '1.0.0',
      pynect: {
        schemaVersion: 1,
        managedPython: '3.11',
        installUv: false,
        autoSync: 'if-missing',
      },
    });
    const config = resolveProjectConfig({
      projectRoot: root,
      managedPython: '3.13',
      env: {
        PYNECT_MANAGED_PYTHON: '3.12',
        PYNECT_INSTALL_UV: 'true',
      },
    });

    expect(config.managedPython).toBe('3.13');
    expect(config.installUv).toBe(true);
    expect(config.autoSync).toBe('if-missing');
    expect(config.installPython).toBe(true);
    expect(config.lockfile).toBe(path.join(root, 'pynect.lock'));
  });
});

describe('manifest aggregation', () => {
  test('discovers transitive requirements and namespaces exposed modules', () => {
    const root = project({
      name: 'example-app',
      version: '1.0.0',
      dependencies: { '@acme/name-generator': '1.0.0' },
      pynect: {
        schemaVersion: 1,
        requiresPython: '>=3.11,<3.14',
        overrides: { packaging: '==24.2' },
      },
    });
    dependency(root, '@acme/name-generator', {
      name: '@acme/name-generator',
      version: '1.0.0',
      pynect: {
        schemaVersion: 1,
        requiresPython: '>=3.12,<3.13',
        requirements: ['name-generator>=1,<2'],
        modules: {
          generator: { import: 'name_generator', include: ['generate_name'] },
        },
      },
    });

    const plan = createProjectPlan({ projectRoot: root });

    expect(plan.pythonRange).toBe('>=3.12.0 <3.13.0');
    expect(plan.config.managedPython).toBe('3.12');
    expect(plan.requirements).toEqual([{
      requirement: 'name-generator>=1,<2',
      packageName: '@acme/name-generator',
    }]);
    expect(plan.overrides).toEqual(['packaging==24.2']);
    expect(plan.modules['@acme/name-generator:generator']).toMatchObject({
      import: 'name_generator',
      include: ['generate_name'],
    });
    expect(moduleDispatcherIncludes(plan)).toEqual(['name_generator.generate_name']);
  });

  test('derives an unconfigured managed Python fallback from the combined range', () => {
    const root = project({
      name: 'legacy-app', version: '1.0.0',
      pynect: { schemaVersion: 1, requiresPython: '>=3.11,<3.12' },
    });
    const plan = createProjectPlan({ projectRoot: root });
    expect(plan.config.managedPython).toBe('3.11');
  });

  test('reports incompatible Python ranges with their package origins', () => {
    const root = project({
      name: 'example-app',
      version: '1.0.0',
      dependencies: { old: '1.0.0', modern: '1.0.0' },
    });
    dependency(root, 'old', {
      name: 'old', version: '1.0.0',
      pynect: { schemaVersion: 1, requiresPython: '<3.12' },
    });
    dependency(root, 'modern', {
      name: 'modern', version: '1.0.0',
      pynect: { schemaVersion: 1, requiresPython: '>=3.13' },
    });

    expect(() => createProjectPlan({ projectRoot: root })).toThrow(/old requires Python <3\.12/);
    expect(() => createProjectPlan({ projectRoot: root })).toThrow(/modern requires Python >=3\.13/);
  });

  test('rejects application policy in dependency manifests', () => {
    const root = project({
      name: 'example-app', version: '1.0.0', dependencies: { unsafe: '1.0.0' },
    });
    dependency(root, 'unsafe', {
      name: 'unsafe', version: '1.0.0',
      pynect: { schemaVersion: 1, requirements: ['demo'], installUv: false },
    });

    expect(() => discoverPynectContributions(root)).toThrow(
      /transitive package unsafe cannot set application policy: installUv/,
    );
  });

  test('requires a lock and state before normal runtime use', () => {
    const root = project({
      name: 'example-app', version: '1.0.0',
      pynect: { schemaVersion: 1, requirements: ['demo==1.0.0'] },
    });
    const plan = createProjectPlan({ projectRoot: root });
    expect(() => validateProjectEnvironment(plan)).toThrow(/Run "pynect sync"/);
  });
});

function project(packageJson: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pynect-test-'));
  temporaryDirectories.push(root);
  writeJson(path.join(root, 'package.json'), packageJson);
  return root;
}

function dependency(root: string, name: string, packageJson: Record<string, unknown>): void {
  writeJson(path.join(root, 'node_modules', ...name.split('/'), 'package.json'), packageJson);
}

function writeJson(destination: string, value: unknown): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
