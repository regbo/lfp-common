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
  renderUvProject,
  validateProjectEnvironment,
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
            autoSync: 'if-missing',
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
    expect(config.autoSync).toBe('if-missing');
    expect(config.installPython).toBe(true);
    expect(config.lockfile).toBe(path.join(root, 'pynect.lock'));
    expect(config.generatedDirectory).toBe(path.join(root, 'node_modules', '.pynect'));
    expect(config.packageManifest.schemaVersion).toBe(1);
    expect(config.packageManifest.project.dependencies).toEqual([]);
  });

  test('allows every config source to use the JSON pyproject shape', () => {
    const root = project({
      name: 'example-app',
      version: '1.0.0',
      pynect: {
        project: {
          'requires-python': '>=3.11,<3.13',
          dependencies: ['pydantic>=2,<3'],
        },
        tool: {
          uv: { 'override-dependencies': ['packaging==24.2'] },
          pynect: { generatedDirectory: '.cache/python-project' },
        },
      },
    });
    const config = resolveProjectConfig({
      projectRoot: root,
      project: { 'requires-python': '>=3.12,<3.13' },
      tool: { pynect: { autoSync: 'if-missing' } },
    });

    expect(config.requiresPython).toBe('>=3.12,<3.13');
    expect(config.autoSync).toBe('if-missing');
    expect(config.generatedDirectory).toBe(path.join(root, '.cache', 'python-project'));
    expect(config.packageManifest.project.dependencies).toEqual(['pydantic>=2,<3']);
    expect(config.packageManifest.tool.uv['override-dependencies']).toEqual(['packaging==24.2']);
  });

  test('uses an explicit generated project location outside node_modules', () => {
    const root = project({
      name: 'example-app',
      version: '1.0.0',
      pynect: { tool: { pynect: { generatedDirectory: 'node_modules/.from-package' } } },
    });
    const config = resolveProjectConfig({
      projectRoot: root,
      env: { PYNECT_GENERATED_DIRECTORY: '.runtime/pynect' },
    });

    expect(config.generatedDirectory).toBe(path.join(root, '.runtime', 'pynect'));
  });

  test('places generated files beside a hoisted Pynect installation by default', () => {
    const monorepo = project({ name: 'workspace-root', version: '1.0.0' });
    dependency(monorepo, 'pynect', { name: 'pynect', version: '0.2.0' });
    const application = path.join(monorepo, 'packages', 'app');
    writeJson(path.join(application, 'package.json'), { name: 'app', version: '1.0.0' });

    const config = resolveProjectConfig({ projectRoot: application });

    expect(path.dirname(config.generatedDirectory)).toBe(
      path.join(monorepo, 'node_modules', '.pynect'),
    );
    expect(path.basename(config.generatedDirectory)).toHaveLength(12);
  });
});

describe('manifest aggregation', () => {
  test('accepts project dependencies from programmatic JSON config', () => {
    const root = project({ name: 'api-app', version: '1.0.0' });
    const plan = createProjectPlan({
      projectRoot: root,
      project: { dependencies: ['numpy>=2,<3'] },
    });

    expect(plan.requirements).toEqual([{
      requirement: 'numpy>=2,<3',
      packageName: 'api-app',
    }]);
    expect(renderUvProject(plan)).toContain('"numpy>=2,<3"');
  });

  test('discovers transitive requirements and namespaces exposed modules', () => {
    const root = project({
      name: 'example-app',
      version: '1.0.0',
      dependencies: { '@acme/name-generator': '1.0.0' },
      pynect: {
        project: { 'requires-python': '>=3.11,<3.14' },
        tool: { uv: { 'override-dependencies': ['packaging==24.2'] } },
      },
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
    expect(renderUvProject(plan)).toContain(
      'requires-python = ">=3.10.0,<4.0.0,>=3.11,<3.14,>=3.12,<3.13"',
    );
    expect(renderUvProject(plan)).toContain('override-dependencies = [\n  "packaging==24.2",\n]');
    expect(plan.generatedDirectory).toBe(path.join(root, 'node_modules', '.pynect'));
    expect(plan.pyprojectFile).toBe(
      path.join(root, 'node_modules', '.pynect', 'pyproject.toml'),
    );
    expect(plan.stateFile).toBe(
      path.join(root, 'node_modules', '.pynect', '.pynect-state.json'),
    );
  });

  test('enforces Pynect\'s Python 3.10 runtime floor', () => {
    const root = project({ name: 'legacy-app', version: '1.0.0' });
    expect(() => createProjectPlan({
      projectRoot: root,
      requiresPython: '>=3.9,<3.10',
    })).toThrow(/pynect requires Python >=3\.10\.0 <4\.0\.0/);
  });

  test('derives an unconfigured managed Python fallback from the combined range', () => {
    const root = project({
      name: 'legacy-app', version: '1.0.0',
      pynect: { project: { 'requires-python': '>=3.11,<3.12' } },
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
      pynect: { project: { 'requires-python': '<3.12' } },
    });
    dependency(root, 'modern', {
      name: 'modern', version: '1.0.0',
      pynect: { project: { 'requires-python': '>=3.13' } },
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
      pynect: {
        project: { dependencies: ['demo'] },
        tool: { pynect: { installUv: false } },
      },
    });

    expect(() => discoverPynectContributions(root)).toThrow(
      /transitive package unsafe cannot set application policy: tool\.pynect\.installUv/,
    );
  });

  test('requires a lock and state before normal runtime use', () => {
    const root = project({
      name: 'example-app', version: '1.0.0',
      pynect: { project: { dependencies: ['demo==1.0.0'] } },
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
