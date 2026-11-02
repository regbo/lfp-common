import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import semver from 'semver';
import { resolveProjectConfig, validatePackageManifest } from '../src/config/project';
import {
  createProjectPlan,
  discoverPynectContributions,
  moduleDispatcherIncludes,
  projectPythonOptions,
} from '../src/env/project-environment';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('project configuration', () => {
  test('uses the current schema when schemaVersion is omitted', () => {
    expect(validatePackageManifest({}, 'inline config').schemaVersion).toBe(1);
    expect(() => validatePackageManifest({ schemaVersion: 2 }, 'inline config')).toThrow(
      /schemaVersion must be 1 when specified/,
    );
    expect(() => validatePackageManifest({ requirements: ['legacy'] }, 'inline config')).toThrow(
      /unknown field\(s\): requirements/,
    );
  });

  test('uses API, environment, package.json, then defaults', () => {
    const root = project({
      name: 'example-app',
      version: '1.0.0',
      pynect: {
        tool: {
          pynect: {
            managedPython: '3.11',
            installUv: false,
          },
        },
      },
    });
    const config = resolveProjectConfig({
      projectRoot: root,
      tool: { pynect: { managedPython: '3.13' } },
      env: {
        PYNECT_MANAGED_PYTHON: '3.12',
        PYNECT_INSTALL_UV: 'true',
      },
    });

    expect(config.managedPython).toBe('3.13');
    expect(config.installUv).toBe(true);
    expect(config.installPython).toBe(true);
    expect(config.packageManifest.schemaVersion).toBe(1);
    expect(config.packageManifest.project.dependencies).toEqual([]);
  });

  test('uses the same JSON project shape for package and API config', () => {
    const root = project({
      name: 'example-app',
      version: '1.0.0',
      pynect: {
        project: {
          'requires-python': '>=3.11,<3.13',
          dependencies: ['pydantic>=2,<3'],
        },
        tool: {
          pynect: { requirements: ['requirements/runtime.txt'] },
        },
      },
    });
    const config = resolveProjectConfig({
      projectRoot: root,
      project: { 'requires-python': '>=3.12,<3.13' },
    });

    expect(config.requiresPython).toBe('>=3.12,<3.13');
    expect(config.requirements).toEqual([path.join(root, 'requirements', 'runtime.txt')]);
    expect(config.packageManifest.project.dependencies).toEqual(['pydantic>=2,<3']);
  });

  test('resolves callback depth from API, environment, package, then Python', () => {
    const root = project({
      name: 'callback-app',
      version: '1.0.0',
      pynect: { tool: { pynect: { callbacks: { maxDepth: 30 } } } },
    });
    expect(resolveProjectConfig({
      projectRoot: root,
      tool: { pynect: { callbacks: { maxDepth: 10 } } },
      env: { PYNECT_CALLBACK_MAX_DEPTH: '20' },
    }).callbackMaxDepth).toBe(10);
    expect(resolveProjectConfig({
      projectRoot: root,
      env: { PYNECT_CALLBACK_MAX_DEPTH: '20' },
    }).callbackMaxDepth).toBe(20);
    expect(resolveProjectConfig({ projectRoot: root }).callbackMaxDepth).toBe(30);
  });
});

describe('manifest aggregation', () => {
  test('passes aggregated dependencies and root requirements directly to Pyfig', () => {
    const root = project({
      name: 'api-app',
      version: '1.0.0',
      pynect: {
        project: { dependencies: ['numpy>=2,<3'] },
        tool: { pynect: { requirements: ['requirements.txt'] } },
      },
    });
    const plan = createProjectPlan({
      projectRoot: root,
      project: { dependencies: ['orjson>=3'] },
    });
    const options = projectPythonOptions(plan);

    expect(plan.dependencies).toEqual([{
      dependency: 'orjson>=3',
      packageName: 'api-app',
    }]);
    expect(options.dependencies).toEqual(['orjson>=3']);
    expect(options.requirements).toEqual([path.join(root, 'requirements.txt')]);
  });

  test('discovers transitive dependencies and namespaces exposed modules', () => {
    const root = project({
      name: 'example-app',
      version: '1.0.0',
      dependencies: { '@acme/name-generator': '1.0.0' },
      pynect: { project: { 'requires-python': '>=3.11,<3.14' } },
    });
    dependency(root, '@acme/name-generator', {
      name: '@acme/name-generator',
      version: '1.0.0',
      pynect: {
        project: {
          'requires-python': '>=3.12,<3.13',
          dependencies: ['name-generator>=1,<2'],
        },
        tool: {
          pynect: {
            modules: {
              generator: { import: 'name_generator', include: ['generate_name'] },
            },
          },
        },
      },
    });

    const plan = createProjectPlan({ projectRoot: root });

    expect(plan.pythonRequirement).toBe(
      '>=3.10.0,<4.0.0,>=3.11,<3.14,>=3.12,<3.13',
    );
    expect(semver.satisfies('3.12.0', plan.pythonRange)).toBe(true);
    expect(semver.satisfies('3.13.0', plan.pythonRange)).toBe(false);
    expect(plan.config.managedPython).toBe('3.12');
    expect(plan.dependencies).toEqual([{
      dependency: 'name-generator>=1,<2',
      packageName: '@acme/name-generator',
    }]);
    expect(plan.modules['@acme/name-generator:generator']).toMatchObject({
      import: 'name_generator',
      include: ['generate_name'],
    });
    expect(moduleDispatcherIncludes(plan)).toEqual(['name_generator.generate_name']);
  });

  test('enforces Pynect Python 3.10 and reports incompatible origins', () => {
    const root = project({
      name: 'example-app',
      version: '1.0.0',
      dependencies: { old: '1.0.0', modern: '1.0.0' },
    });
    dependency(root, 'old', {
      name: 'old', version: '1.0.0',
      pynect: { project: { 'requires-python': '<3.12' } },
    });
    dependency(root, 'modern', {
      name: 'modern', version: '1.0.0',
      pynect: { project: { 'requires-python': '>=3.13' } },
    });

    expect(() => createProjectPlan({ projectRoot: root })).toThrow(/old requires Python <3\.12/);
    expect(() => createProjectPlan({ projectRoot: root })).toThrow(/modern requires Python >=3\.13/);
    expect(() => createProjectPlan({
      projectRoot: project({ name: 'legacy', version: '1.0.0' }),
      project: { 'requires-python': '>=3.9,<3.10' },
    })).toThrow(/pynect requires Python >=3\.10\.0 <4\.0\.0/);
  });

  test('rejects application policy in dependency manifests', () => {
    const root = project({
      name: 'example-app', version: '1.0.0', dependencies: { unsafe: '1.0.0' },
    });
    dependency(root, 'unsafe', {
      name: 'unsafe', version: '1.0.0',
      pynect: {
        project: { dependencies: ['demo'] },
        tool: { pynect: { installUv: false } },
      },
    });

    expect(() => discoverPynectContributions(root)).toThrow(
      /transitive package unsafe cannot set application policy: tool\.pynect\.installUv/,
    );
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
