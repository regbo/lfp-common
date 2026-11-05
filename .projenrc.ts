import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IConstruct, IMixin } from 'constructs';
import {
  Component,
  DependencyType,
  JsonFile,
  Project,
  TextFile,
  github,
  javascript,
  python,
  typescript,
} from 'projen';

/** Enforce `.projenrc.ts` as the only writable source for synthesized files. */
class ReadonlyGeneratedFiles implements IMixin {
  supports(construct: IConstruct): construct is Project {
    return construct instanceof Project;
  }

  applyTo(construct: IConstruct): void {
    if (!this.supports(construct)) {
      throw new TypeError('ReadonlyGeneratedFiles only supports Projen projects.');
    }

    new ReadonlyGeneratedFilesPolicy(construct);
    for (const subproject of construct.subprojects) subproject.with(this);
  }
}

/** Apply after other components have declared their generated files. */
class ReadonlyGeneratedFilesPolicy extends Component {
  override preSynthesize(): void {
    for (const file of this.project.files) file.readonly = true;
  }
}

const VERSION = '0.8.11';
const BUN_VERSION = '1.4.4';
const PROJEN_VERSION = '0.104.23';
const PROJEN_COMMAND = 'bunx projen';
const SETUP_UV_ACTION = 'astral-sh/setup-uv@68559e99cc807c1eb7e9238fd43a15bba460eec2';
const BOOTSTRAP_GITHUB_REPOSITORY = 'regbo/lfp-common';
const GITHUB_REPOSITORY = githubRepositoryFromRemote(gitOriginUrl())
  ?? BOOTSTRAP_GITHUB_REPOSITORY;
const GITHUB_AUTHOR = GITHUB_REPOSITORY.split('/')[0]!;
const GITHUB_URL = `https://github.com/${GITHUB_REPOSITORY}`;
const REPOSITORY = `${GITHUB_URL}.git`;
const BUGS_URL = `${GITHUB_URL}/issues`;
const ROOT_DIRECTORY = fileURLToPath(new URL('.', import.meta.url));
const JS_PROJECT_DEFAULTS = {
  repository: REPOSITORY,
  bugsUrl: BUGS_URL,
  authorName: GITHUB_AUTHOR,
  authorUrl: `https://github.com/${GITHUB_AUTHOR}`,
  license: 'MIT',
  packageManager: javascript.NodePackageManager.BUN,
  bunVersion: BUN_VERSION,
  npmignoreEnabled: false,
  package: false,
  jest: false,
  addPackageManagerToDevEngines: false,
} satisfies Partial<typescript.TypeScriptProjectOptions>;

/** Use the containing folder as project identity unless a caller opts out explicitly. */
function projectName(directory: string, override?: string): string {
  if (override !== undefined) {
    const name = override.trim();
    if (!name) throw new Error(`Project name override for ${directory} cannot be empty.`);
    return name;
  }

  const name = path.basename(path.resolve(directory));
  if (!name) throw new Error(`Could not derive a project name from ${directory}.`);
  return name;
}

function projectRelativePath(project: Project): string {
  const relative = path.relative(ROOT_DIRECTORY, project.outdir);
  return relative === '' ? '.' : relative.split(path.sep).join(path.posix.sep);
}

function pyprojectMetadata(
  project: Project,
  metadata: Partial<python.PyprojectTomlProject>,
): python.PyprojectTomlProject {
  const isSubproject = project.parent !== undefined;
  const outdir = projectRelativePath(project);
  return {
    ...(isSubproject ? {
      readme: 'README.md',
      license: 'MIT',
    } : {}),
    ...metadata,
    name: metadata.name ?? project.name,
    version: VERSION,
    requiresPython: metadata.requiresPython ?? '>=3.11',
    authors: metadata.authors ?? [{ name: GITHUB_AUTHOR }],
    classifiers: isSubproject ? [
      'Programming Language :: Python :: 3',
      'Programming Language :: Python :: 3.11',
      'Programming Language :: Python :: 3.12',
      'Programming Language :: Python :: 3.13',
      'Programming Language :: Python :: 3.14',
      'Typing :: Typed',
      ...(metadata.classifiers ?? []),
    ] : metadata.classifiers,
    urls: isSubproject ? {
      Homepage: `${GITHUB_URL}/tree/main/${outdir}#readme`,
      Repository: REPOSITORY,
      Issues: BUGS_URL,
      ...metadata.urls,
    } : metadata.urls,
  };
}

/** The only source of external dependency versions for every workspace. */
const CATALOG = {
  '@antfu/install-pkg': '^2.1.0',
  '@chanx-js/client': '^2.4.0',
  '@chanx-js/codegen': '^2.1.2',
  '@renovatebot/pep440': '^5.0.1',
  '@types/bun': '^1.4.4',
  '@types/fs-ext': '^2.0.3',
  '@types/node': '^26.6.6',
  '@types/proper-lockfile': '^4.1.4',
  '@types/semver': '^7.8.0',
  '@types/which': '^3.0.4',
  'async-mutex': '^0.5.0',
  'clean-stack': '^7.0.0',
  'constructs': '^10.0.0',
  'fflate': '^0.8.3',
  'fireargs': '^0.6.2',
  'fs-ext': '^2.1.1',
  'ohash': '^2.0.12',
  'pacwich': '^0.7.3',
  'proper-lockfile': '^4.1.2',
  'projen': PROJEN_VERSION,
  'read-package-up': '^12.0.0',
  'semver': '^7.8.5',
  'smol-toml': '^1.4.2',
  'tar': '^7.5.22',
  'typescript': '^5.9.3',
  'undici': '^8.12.3',
  'which': '^6.0.1',
  'zod': '^4.6.7',
} as const;

const root = new javascript.NodeProject({
  ...JS_PROJECT_DEFAULTS,
  name: projectName(ROOT_DIRECTORY),
  description: 'Shared libraries and Python integrations for LFP Connect.',
  homepage: `${GITHUB_URL}#readme`,
  entrypoint: '',
  projenrcJs: false,
  release: false,
  autoMerge: false,
  depsUpgrade: false,
  buildWorkflowOptions: {
    mutableBuild: false,
    mutableInstall: false,
    preBuildSteps: [
      {
        name: 'Setup Node.js',
        uses: github.ActionRefs.ACTIONS_SETUP_NODE,
        with: {
          'node-version': '24',
          'package-manager-cache': false,
        },
      },
      {
        name: 'Setup uv',
        uses: SETUP_UV_ACTION,
        with: { version: 'latest-known' },
      },
    ],
  },
  workflowPermissions: {
    contents: github.workflows.JobPermission.READ,
  },
  workflowNodeVersion: '24',
  pullRequestTemplate: false,
});

root.package.addVersion(VERSION);
root.addFields({
  private: true,
  type: 'module',
  packageManager: `bun@${BUN_VERSION}`,
  workspaces: {
    packages: ['packages/js/*', 'packages/py/*'],
    catalog: CATALOG,
  },
});
const rootVsCode = root.vscode;
if (!rootVsCode) throw new Error('Root VS Code integration must be enabled.');
rootVsCode.extensions.addRecommendations('charliermarsh.ruff');
rootVsCode.settings.addSettings({
  'editor.codeActionsOnSave': {
    'source.fixAll.ruff': 'explicit',
    'source.organizeImports.ruff': 'explicit',
  },
  'editor.defaultFormatter': 'charliermarsh.ruff',
  'editor.formatOnSave': true,
}, 'python');
rootVsCode.settings.addSettings({
  'python.defaultInterpreterPath': '${workspaceFolder}/.venv',
  'python.analysis.diagnosticMode': 'workspace',
  'python.analysis.extraPaths': ['packages/py/*/src'],
  'python.analysis.include': [
    'packages/py/**/src/**/*.py',
    'packages/py/**/tests/**/*.py',
  ],
});
rootVsCode.settings.addSetting('ruff.configurationPreference', 'filesystemFirst');
for (const pattern of [
  '.venv/',
  '**/__pycache__/',
  '*.pyc',
  '*.tgz',
  'coverage/',
  'dist/',
  'packages/js/*/dist/',
  'packages/js/*/release/',
  'packages/py/*/dist/',
] as const) root.addGitIgnore(pattern);
root.tasks.removeTask('clobber');
root.tasks.removeTask('eject');

const nodeInstallTask = root.tasks.tryFind('install');
const nodeInstallCiTask = root.tasks.tryFind('install:ci');
if (!nodeInstallTask || !nodeInstallCiTask) {
  throw new Error('Node install tasks must exist before configuring uv.');
}
const nodeInstallSteps = [...nodeInstallTask.steps];
const nodeInstallCiSteps = [...nodeInstallCiTask.steps];
root.tasks.removeTask(nodeInstallTask.name);
root.tasks.removeTask(nodeInstallCiTask.name);
const rootUv = new python.Uv(root, {
  project: pyprojectMetadata(root, {
    description: 'Shared Python workspace for LFP Connect libraries and examples',
  }),
  uv: {
    package: false,
    workspace: { members: ['packages/py/*'] },
  },
});
rootUv.installTask.reset();
rootUv.installTask.addSteps(...nodeInstallSteps);
rootUv.installTask.execArgs(['uv', 'sync', '--all-packages', '--all-groups']);
rootUv.installCiTask.reset();
rootUv.installCiTask.addSteps(...nodeInstallCiSteps);
rootUv.installCiTask.execArgs([
  'uv', 'sync', '--all-packages', '--all-groups', '--locked',
]);
root.tasks.removeTask(rootUv.publishTask.name);
root.tasks.removeTask(rootUv.publishTestTask.name);

const baseTsconfig = new javascript.TypescriptConfig(root, {
  fileName: 'tsconfig.base.json',
  include: [],
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: javascript.TypeScriptModuleResolution.NODE_NEXT,
    lib: ['ES2022'],
    strict: true,
    noImplicitReturns: true,
    noFallthroughCasesInSwitch: true,
    noUncheckedIndexedAccess: true,
    forceConsistentCasingInFileNames: true,
    esModuleInterop: true,
    skipLibCheck: true,
    types: ['bun', 'node'],
  },
});

const projenrc = new typescript.ProjenrcTs(root, {
  runner: typescript.TypeScriptRunner.nodejs({
    typeCheck: false,
  }),
});
projenrc.tsconfig.addExtends(baseTsconfig);
projenrc.tsconfig.removeInclude('**/*.ts');

new javascript.TypescriptConfig(root, {
  fileName: 'tsconfig.json',
  extends: javascript.TypescriptConfigExtends.fromTypescriptConfigs([baseTsconfig]),
  compilerOptions: {
    allowImportingTsExtensions: true,
    noEmit: true,
    rootDir: '.',
  },
  include: ['.projenrc.ts', 'scripts/**/*.ts', 'tests/**/*.ts'],
  exclude: ['dist', 'node_modules', 'packages'],
});

replaceBuildDependencies(root, [
  '@types/bun@catalog:',
  '@types/node@catalog:',
  '@types/semver@catalog:',
  'constructs@catalog:',
  'pacwich@catalog:',
  'projen@catalog:',
  'semver@catalog:',
  'smol-toml@catalog:',
  'typescript@catalog:',
]);

interface PackageMetadataOptions {
  readonly libdir: string;
  readonly name: string;
  readonly requirePath?: string;
  readonly srcdir: string;
}

/** Synthesize package identity and merge its public subpath into the final manifest. */
class PackageMetadata extends Component {
  readonly #nodeProject: typescript.TypeScriptProject;
  readonly #options: PackageMetadataOptions;

  constructor(
    project: typescript.TypeScriptProject,
    options: PackageMetadataOptions,
  ) {
    super(project);
    this.#nodeProject = project;
    this.#options = options;
    new TextFile(project, `${options.srcdir}/_generated/metadata.ts`, {
      committed: true,
      readonly: true,
      lines: [
        '/** Package identity synthesized from the shared Projen configuration. */',
        `export const PACKAGE_NAME = ${JSON.stringify(options.name)} as const;`,
        `export const PACKAGE_VERSION = ${JSON.stringify(VERSION)} as const;`,
      ],
    });
  }

  override preSynthesize(): void {
    const configured = this.#nodeProject.package.manifest.exports;
    if (configured !== undefined && (
      configured === null ||
      typeof configured !== 'object' ||
      Array.isArray(configured)
    )) {
      throw new TypeError(`${this.#nodeProject.name} package exports must be an object.`);
    }
    this.#nodeProject.package.addField('exports', {
      ...(configured as Record<string, unknown> | undefined),
      './metadata': packageMetadataExport(
        this.#options.libdir,
        this.#options.requirePath,
      ),
    });
  }
}

/** Create one uv_build package with the repository's shared Python defaults. */
function createPyPackage(
  outdir: string,
  metadata: Partial<python.PyprojectTomlProject>,
  ...modifiers: readonly ((uv: python.Uv) => void)[]
): python.Uv {
  const name = projectName(outdir, metadata.name);
  const dependencies = metadata.dependencies ?? [];
  const project = new Project({
    name,
    parent: root,
    outdir,
    projenCommand: PROJEN_COMMAND,
  });
  const uv = new python.Uv(project, {
    project: pyprojectMetadata(project, {
      ...metadata,
      dependencies,
    }),
    buildSystem: {
      requires: ['uv_build>=0.10.7,<0.11'],
      buildBackend: 'uv_build',
    },
    uv: {
      buildBackend: {
        moduleName: name.replaceAll('-', '_').replaceAll('.', '_'),
        moduleRoot: 'src',
      },
    },
  });
  const workspaceSources = Object.fromEntries(dependencies.flatMap((dependency) => {
    const workspaceName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.exec(dependency)?.[0];
    return workspaceName ? [[workspaceName, { workspace: true }]] : [];
  }));
  if (Object.keys(workspaceSources).length > 0) {
    uv.file.addOverride('tool.uv.sources', workspaceSources);
  }
  uv.file.addOverride('dependency-groups.dev', ['ruff>=0.17,<1']);
  uv.file.addOverride('tool.ruff', {
    'line-length': 120,
    'target-version': 'py311',
    src: ['src'],
    format: {
      'indent-style': 'space',
      'line-ending': 'lf',
      'quote-style': 'double',
    },
    lint: { select: ['E', 'F', 'I', 'UP', 'B', 'SIM'] },
  });
  project.tasks.addEnvironment('VIRTUAL_ENV', path.posix.relative(outdir, '.venv'));
  for (const pattern of ['.venv/', '__pycache__/', '.pytest_cache/', '*.pyc', 'dist/']) {
    project.addGitIgnore(pattern);
  }
  project.addTask('check', {
    execArgs: ['uv', 'run', '--locked', '--package', name, 'ruff', 'check', 'src'],
  });
  project.addTask('format', {
    execArgs: ['uv', 'run', '--locked', '--package', name, 'ruff', 'format', 'src'],
  });
  project.addTask('format:check', {
    execArgs: [
      'uv', 'run', '--locked', '--package', name, 'ruff', 'format', '--check', 'src',
    ],
  });
  for (const modifier of modifiers) modifier(uv);
  return uv;
}

function pythonPackages(): python.Uv[] {
  return root.subprojects.flatMap(project => project.components.filter(
    (component): component is python.Uv => component instanceof python.Uv,
  ));
}

/** Create one publishable Bun/TypeScript package with shared metadata and tasks. */
function createJsPackage(
  outdir: string,
  options: Partial<typescript.TypeScriptProjectOptions>,
  ...modifiers: readonly ((project: typescript.TypeScriptProject) => void)[]
): typescript.TypeScriptProject {
  const {
    name: nameOverride,
    ...projectOptions
  } = options;
  const name = projectName(outdir, nameOverride);
  const srcdir = projectOptions.srcdir ?? 'src';
  const libdir = projectOptions.libdir ?? 'dist';
  const testdir = projectOptions.testdir ?? 'tests';
  const module = projectOptions.tsconfig?.compilerOptions?.module ?? 'NodeNext';
  const commonJsModule = module === 'CommonJS';
  const project = new typescript.TypeScriptProject({
    ...JS_PROJECT_DEFAULTS,
    homepage: `${GITHUB_URL}/tree/main/${outdir}#readme`,
    eslint: false,
    sampleCode: false,
    entrypoint: `${libdir}/index.js`,
    autoDetectBin: false,
    peerDependencyOptions: {
      pinnedDevDependency: false,
    },
    typescriptVersion: CATALOG.typescript,
    ...projectOptions,
    parent: root,
    name,
    outdir,
    repositoryDirectory: outdir,
    libdir,
    testdir,
    tsconfig: {
      ...projectOptions.tsconfig,
      extends: projectOptions.tsconfig?.extends
        ?? javascript.TypescriptConfigExtends.fromTypescriptConfigs([baseTsconfig]),
      compilerOptions: {
        declarationMap: true,
        sourceMap: true,
        inlineSourceMap: false,
        target: 'ES2022',
        lib: ['ES2022'],
        experimentalDecorators: false,
        noEmitOnError: true,
        noUnusedLocals: false,
        noUnusedParameters: false,
        stripInternal: false,
        module,
        moduleResolution: commonJsModule
          ? javascript.TypeScriptModuleResolution.NODE
          : javascript.TypeScriptModuleResolution.NODE_NEXT,
        verbatimModuleSyntax: !commonJsModule,
        ...projectOptions.tsconfig?.compilerOptions,
      },
      include: projectOptions.tsconfig?.include ?? [`${srcdir}/**/*.ts`, `${srcdir}/**/*.mts`],
      exclude: projectOptions.tsconfig?.exclude ?? ['dist', 'release', 'node_modules', testdir],
    },
    tsconfigDev: {
      ...projectOptions.tsconfigDev,
      compilerOptions: {
        allowImportingTsExtensions: true,
        module: commonJsModule ? 'ESNext' : undefined,
        moduleResolution: commonJsModule
          ? javascript.TypeScriptModuleResolution.BUNDLER
          : undefined,
        ...projectOptions.tsconfigDev?.compilerOptions,
      },
    },
  });

  project.package.addVersion(VERSION);
  const mainPath = packagePath(projectOptions.entrypoint ?? `${libdir}/index.js`);
  const typesPath = packagePath(projectOptions.entrypointTypes ?? `${libdir}/index.d.ts`);
  const importPath = packagePath(`${libdir}/index.js`);
  const commonJsEntrypoint = mainPath !== importPath;
  new PackageMetadata(project, {
    libdir,
    name,
    requirePath: commonJsEntrypoint
      ? packagePath(path.posix.join(path.posix.dirname(mainPath), '_generated/metadata.js'))
      : undefined,
    srcdir,
  });
  project.addFields({
    type: 'module',
    sideEffects: false,
    files: [`${libdir}/`, 'README.md'],
    engines: {
      node: '^22.11.0 || >=24.10.0 <=26.x',
      bun: '>=1.2.0',
    },
    exports: {
      '.': {
        types: typesPath,
        import: importPath,
        ...(commonJsEntrypoint ? { require: mainPath } : { default: importPath }),
      },
    },
  });
  const archiveDirectory = path.posix.relative(outdir, 'dist/packages');
  project.addScripts({
    'pack:release': `bun pm pack --ignore-scripts --destination ${archiveDirectory} --quiet`,
    'publish:release': `npm publish ${archiveDirectory}/${name}-${VERSION}.tgz --access public --tag latest --provenance`,
  });
  replaceBuildDependencies(project, [
    '@types/bun@catalog:',
    '@types/node@catalog:',
    'typescript@catalog:',
    ...(projectOptions.devDeps ?? []),
  ]);

  configureScriptTypes(project, path.posix.relative(`${outdir}/scripts`, '.'));
  const devTsconfigRoot = projectOptions.tsconfigDev?.compilerOptions?.rootDir;
  if (devTsconfigRoot) {
    if (!project.tsconfigDev) throw new Error(`${name} development tsconfig must be enabled.`);
    project.tsconfigDev.file.addOverride('compilerOptions.rootDir', devTsconfigRoot);
  }
  project.testTask.reset();
  project.testTask.execArgs(['bun', 'test']);
  configureTypecheck(project, [
    ['tsc', '--noEmit', '-p', 'tsconfig.json'],
    ['tsc', '--noEmit', '-p', 'scripts/tsconfig.json'],
    ['tsc', '--noEmit', '-p', 'tests/tsconfig.json'],
  ]);
  for (const modifier of modifiers) modifier(project);

  return project;
}

function packagePath(file: string): string {
  return file.startsWith('.') ? file : `./${file}`;
}

/** Build the public export map for a workspace's generated package metadata. */
function packageMetadataExport(libdir: string, requirePath?: string) {
  const modulePath = `./${libdir}/_generated/metadata.js`;
  return {
    types: `./${libdir}/_generated/metadata.d.ts`,
    import: modulePath,
    ...(requirePath ? { require: requirePath } : { default: modulePath }),
  };
}

const loqkit = createJsPackage('packages/js/loqkit', {
  description: 'Typed memoization and layered memory, worker-thread, and file locks for JavaScript runtimes.',
  libdir: 'release',
  testdir: 'test',
  entrypoint: 'release/cjs/index.js',
  tsconfig: { compilerOptions: { exactOptionalPropertyTypes: true } },
  deps: [
    'async-mutex@catalog:',
    'ohash@catalog:',
    'proper-lockfile@catalog:',
    'read-package-up@catalog:',
    'zod@catalog:',
  ],
  devDeps: [
    '@types/fs-ext@catalog:',
    '@types/proper-lockfile@catalog:',
  ],
  keywords: [
    'lock',
    'mutex',
    'concurrency',
    'flock',
    'lockfile',
    'worker-threads',
    'memoization',
    'memoize',
    'typescript',
  ],
}, project => {
  project.addFields({
    files: ['release/', 'src/', 'README.md'],
    engines: { node: '>=20' },
    optionalDependencies: { 'fs-ext': 'catalog:' },
  });
  project.compileTask.reset();
  project.compileTask.execArgs(['tsc', '-p', 'tsconfig.json']);
  project.compileTask.execArgs(['bun', 'scripts/build-cjs.ts']);
  configureTypecheck(project, [
    ['tsc', '--noEmit', '-p', 'tsconfig.json'],
    ['tsc', '--noEmit', '-p', 'scripts/tsconfig.json'],
  ]);
});

const optionkit = createJsPackage('packages/js/optionkit', {
  description: 'Turn Zod configuration schemas into zero-setup CLI options.',
  deps: [
    '@antfu/install-pkg@catalog:',
    'semver@catalog:',
  ],
  devDeps: [
    '@types/semver@catalog:',
    'clean-stack@catalog:',
    'fireargs@catalog:',
    'zod@catalog:',
  ],
  peerDeps: [
    'fireargs@catalog:',
    'zod@catalog:',
  ],
  keywords: ['args', 'cli', 'config', 'environment', 'fireargs', 'zod'],
}, project => {
  project.addFields({
    engines: { node: '>=18' },
    peerDependenciesMeta: {
      fireargs: { optional: true },
      zod: { optional: true },
    },
  });
  project.compileTask.reset();
  project.compileTask.execArgs(['bun', 'scripts/build.ts']);
  project.testTask.reset();
  project.testTask.execArgs(['bun', 'scripts/generate-catalog.ts']);
  project.testTask.execArgs(['bun', 'test']);
  configureTypecheck(project, [
    ['bun', 'scripts/generate-catalog.ts'],
    ['tsc', '--noEmit', '-p', 'tsconfig.json'],
    ['tsc', '--noEmit', '-p', 'scripts/tsconfig.json'],
    ['tsc', '--noEmit', '-p', 'tests/tsconfig.json'],
  ]);
  project.addTask('test:packed', {
    description: 'Smoke-test the packed package in an isolated consumer.',
    execArgs: ['bun', 'scripts/test-packed.ts'],
  });
});

const pyfig = createJsPackage('packages/js/pyfig', {
  description: 'Bootstrap uv and delegate Python execution to it.',
  entrypoint: 'dist/cjs/index.js',
  bin: { pyfig: './dist/cli.js' },
  deps: [
    '@renovatebot/pep440@catalog:',
    'fflate@catalog:',
    'loqkit@workspace:*',
    'optionkit@workspace:*',
    'tar@catalog:',
    'undici@catalog:',
    'which@catalog:',
    'zod@catalog:',
  ],
  devDeps: ['@types/which@catalog:'],
  keywords: ['python', 'uv', 'bun', 'node'],
}, project => {
  project.package.addField('exports', {
    ...(project.package.manifest.exports as Record<string, unknown>),
      './cli': {
        types: './dist/cli.d.ts',
        import: './dist/cli.js',
      },
  });
  project.addFields({ files: ['dist/', 'README.md', 'SECURITY.md'] });
  project.compileTask.reset();
  project.compileTask.execArgs(['bun', 'scripts/build.ts']);
  project.addScripts({ pyfig: 'bun ./src/cli.ts' });
});

const pynectWorker = createPyPackage(
  'packages/py/pynect-worker',
  {
    description: 'Chanx schema export and owned stdio adapter for Pynect',
    dependencies: ['chanx[fast_channels]>=2.13.0,<3'],
    classifiers: [
      'Development Status :: 4 - Beta',
      'Environment :: Console',
    ],
    scripts: {
      'pynect-schema': 'pynect_worker.schema:main',
    },
  },
  uv => {
    const project = uv.project;
    uv.file.addOverride('dependency-groups.dev', ['pytest>=9,<10', 'ruff>=0.17,<1']);
    uv.file.addOverride('tool.pytest.ini_options', { testpaths: ['tests'] });
    uv.file.addOverride('tool.ruff.exclude', ['src/pynect_worker/_generated']);
    uv.file.addOverride('tool.ruff.src', ['src', 'tests']);
    project.testTask.reset();
    project.testTask.execArgs([
      'uv', 'run', '--locked', '--package', project.name, 'python', '-m', 'pytest',
    ]);
    project.tasks.tryFind('check')?.reset();
    project.tasks.tryFind('check')?.execArgs([
      'uv', 'run', '--locked', '--package', project.name, 'ruff', 'check', 'src', 'tests',
    ]);
    project.tasks.tryFind('format')?.reset();
    project.tasks.tryFind('format')?.execArgs([
      'uv', 'run', '--locked', '--package', project.name, 'ruff', 'format', 'src', 'tests',
    ]);
    project.tasks.tryFind('format:check')?.reset();
    project.tasks.tryFind('format:check')?.execArgs([
      'uv', 'run', '--locked', '--package', project.name,
      'ruff', 'format', '--check', 'src', 'tests',
    ]);
    new TextFile(project, 'src/pynect_worker/_generated/__init__.py', {
      committed: true,
      readonly: true,
      lines: ['"""Generated package metadata."""'],
    });
    new TextFile(project, 'src/pynect_worker/_generated/metadata.py', {
      committed: true,
      readonly: true,
      lines: [
        '"""Package identity synthesized from the shared Projen configuration."""',
        `PACKAGE_NAME = ${JSON.stringify(project.name)}`,
        `PACKAGE_VERSION = ${JSON.stringify(VERSION)}`,
      ],
    });
    project.gitattributes.addAttributes(
      '/src/pynect_worker/_generated/**',
      'linguist-generated',
    );
  },
);

const pynectWorkerExample = createPyPackage(
  'packages/py/pynect-worker-example',
  {
    description: 'Python-owned Chanx model catalog consumed by the Pynect TypeScript example',
    dependencies: [
      'chanx[fast_channels]>=2.13.0,<3',
      'coolname>=5,<6',
      pynectWorker.project.name,
      'uvicorn[standard]>=0.40,<1',
    ],
  },
  uv => {
    const project = uv.project;
    project.tasks.removeTask('publish');
    project.tasks.removeTask('publish:test');
    uv.file.addOverride('tool.ruff.lint.per-file-ignores', {
      // The marker intentionally runs before imports so startup timing excludes them.
      'src/pynect_worker_example/benchmark_native.py': ['E402'],
    });
    uv.file.addOverride('tool.pynect', {
      name: 'model-catalog',
      app: 'pynect_worker_example.server:app',
      out: '_generated/model-catalog',
    });
    new JsonFile(project, 'package.json', {
      obj: {
        name: project.name,
        version: VERSION,
        private: true,
        type: 'module',
        dependencies: {
          '@chanx-js/client': 'catalog:',
          optionkit: 'workspace:*',
          pynect: 'workspace:*',
        },
      },
    });
    new TextFile(project, 'src/pynect_worker_example/__init__.py', {
      committed: true,
      lines: ['"""Pynect model-catalog example application."""', ''],
    });
    project.gitattributes.addAttributes('/_generated/**', 'linguist-generated');
  },
);

const pynect = createJsPackage('packages/js/pynect', {
  description: 'Generate Chanx clients from Python and run them through an owned stdio worker.',
  tsconfig: {
    compilerOptions: {
      module: 'NodeNext',
      lib: ['ES2022', 'ESNext.Disposable'],
    },
  },
  bin: { pynect: 'dist/cli.js' },
  deps: [
    '@chanx-js/client@catalog:',
    '@chanx-js/codegen@catalog:',
    'optionkit@workspace:*',
    'pyfig@workspace:*',
    'smol-toml@catalog:',
    'zod@catalog:',
  ],
  keywords: [
    'python',
    'nodejs',
    'bun',
    'typescript',
    'chanx',
    'asyncapi',
    'codegen',
    'uv',
    'stdio',
    'subprocess',
    'worker',
    'websocket',
  ],
});
const pynectWorkerExampleFromJs = path.posix.relative(
  projectRelativePath(pynect),
  projectRelativePath(pynectWorkerExample.project),
);
pynect.addFields({ files: ['dist/', 'README.md', 'SECURITY.md'] });
pynect.compileTask.reset();
pynect.compileTask.execArgs([
  'bun', 'src/cli.ts', 'generate', '--root', pynectWorkerExampleFromJs,
]);
pynect.compileTask.execArgs(['bun', 'scripts/build.ts']);
pynect.testTask.reset();
pynect.testTask.execArgs(['bun', 'test']);
pynect.testTask.execArgs(['bun', `${pynectWorkerExampleFromJs}/local.ts`]);
configureTypecheck(pynect, [
  ['tsc', '--noEmit', '-p', 'tsconfig.json'],
  ['tsc', '--noEmit', '-p', 'scripts/tsconfig.json'],
  ['tsc', '--noEmit', '-p', 'tests/tsconfig.json'],
  ['tsc', '--noEmit', '-p', `${pynectWorkerExampleFromJs}/tsconfig.json`],
]);
if (!pynect.tsconfigDev) throw new Error('Pynect development tsconfig must be enabled.');
pynect.tsconfigDev.file.addOverride(
  'compilerOptions.rootDir',
  path.posix.relative(`${projectRelativePath(pynect)}/tests`, '.'),
);
new javascript.TypescriptConfig(pynectWorkerExample.project, {
  fileName: 'tsconfig.json',
  extends: javascript.TypescriptConfigExtends.fromTypescriptConfigs([pynect.tsconfig!]),
  compilerOptions: {
    allowImportingTsExtensions: true,
    noEmit: true,
    rootDir: path.posix.relative(projectRelativePath(pynectWorkerExample.project), '.'),
  },
  include: ['**/*.ts'],
  exclude: ['node_modules'],
});
pynect.addScripts({
  'benchmark:application': 'bun scripts/benchmark-application.ts',
  'benchmark:stdio': 'bun scripts/benchmark-stdio.ts',
  'example:cli': `bun ${pynectWorkerExampleFromJs}/cli.ts`,
  'example:generate': `bun src/cli.ts generate --root ${pynectWorkerExampleFromJs}`,
  'example:local': `bun ${pynectWorkerExampleFromJs}/local.ts`,
  'example:remote': `bun ${pynectWorkerExampleFromJs}/remote.ts`,
  'example:serve': [
    'uv run --package', pynectWorkerExample.project.name,
    'uvicorn pynect_worker_example.server:app --host 127.0.0.1 --port 7777',
  ].join(' '),
});

const WORKSPACE_FILTER = './packages/js/*';
const PACWICH = ['bun', 'node_modules/pacwich/bin/cli.js'] as const;

root.compileTask.reset();
root.compileTask.execArgs([
  ...PACWICH,
  'run',
  'compile',
  '--dep-order',
  '--parallel=false',
  '--output-style=plain',
]);

root.testTask.reset();
root.testTask.execArgs([
  'bun',
  'test',
  'tests/monorepo.test.ts',
  'tests/release-lib.test.ts',
]);
root.testTask.execArgs(['bun', 'run', '--filter', WORKSPACE_FILTER, 'test']);
for (const { project } of pythonPackages()) {
  for (const step of project.testTask.steps) {
    root.testTask.addSteps({ ...step, cwd: projectRelativePath(project) });
  }
}

const workspaceTypecheck = root.addTask('typecheck:workspaces', {
  description: 'Type-check Projen, shared scripts, and built workspaces.',
});
workspaceTypecheck.execArgs([...PACWICH, 'verify', '--strict']);
workspaceTypecheck.execArgs(['bun', 'x', 'tsc', '--noEmit', '-p', 'tsconfig.json']);
workspaceTypecheck.execArgs(['bun', 'run', '--filter', WORKSPACE_FILTER, 'typecheck']);
for (const { project } of pythonPackages()) {
  for (const taskName of ['check', 'format:check']) {
    for (const step of project.tasks.tryFind(taskName)?.steps ?? []) {
      workspaceTypecheck.addSteps({ ...step, cwd: projectRelativePath(project) });
    }
  }
}

const typecheck = root.addTask('typecheck', {
  description: 'Build workspace dependencies, then type-check the monorepo.',
});
typecheck.spawn(root.compileTask);
typecheck.spawn(workspaceTypecheck);

root.packageTask.reset();
root.packageTask.execArgs(['bun', 'run', '--filter', WORKSPACE_FILTER, 'pack:release']);
for (const { project } of pythonPackages().filter(uv => uv.project.tasks.tryFind('publish'))) {
  root.packageTask.execArgs([
    'uv', 'build', '--package', project.name,
    '--out-dir', 'dist/packages/python', '--no-sources',
  ]);
}

root.postCompileTask.spawn(workspaceTypecheck);

const verify = root.addTask('verify', {
  description: 'Synthesize, build, type-check, test, and pack all workspaces.',
});
verify.spawn(root.buildTask);

root.addTask('release', {
  description: 'Verify, version, tag, and atomically push the shared release.',
  execArgs: ['bun', 'scripts/release.ts'],
  receiveArgs: true,
});
root.addTask('release:check', {
  description: 'Validate a release tag and registry availability.',
  execArgs: ['bun', 'scripts/release-check.ts'],
  receiveArgs: true,
});
root.addTask('publish:release', {
  description: 'Publish the generated archives using npm trusted publishing.',
  execArgs: [
    ...PACWICH,
    'run',
    'publish:release',
    '--dep-order',
    '--parallel=false',
    '--output-style=plain',
  ],
});

new TextFile(root, 'README.md', {
  lines: [
    '# lfp-common',
    '',
    'The shared Bun and uv monorepo for LFP Connect libraries.',
    '',
    '| Package | Purpose |',
    '| --- | --- |',
    '| [`loqkit`](packages/js/loqkit) | Typed memoization and layered locks. |',
    '| [`optionkit`](packages/js/optionkit) | Zod-backed CLI configuration. |',
    '| [`pyfig`](packages/js/pyfig) | uv bootstrap and Python execution. |',
    '| [`pynect`](packages/js/pynect) | Python-owned Chanx APIs with generated TypeScript and an owned stdio worker. |',
    '| [`pynect-worker`](packages/py/pynect-worker) | Python schema export, iterator handlers, and stdio runtime. |',
    '| [`pynect-worker-example`](packages/py/pynect-worker-example) | Non-published model-catalog workspace member. |',
    '',
    'All packages use the version declared in `.projenrc.ts`, external versions come from its Bun catalog, and sibling packages use `workspace:*`.',
    'Every workspace publishes its generated `PACKAGE_NAME` and `PACKAGE_VERSION` constants from the `./metadata` subpath.',
    '',
    'Run `uv sync` for the shared Python environment, `bun run projen` after changing project configuration, and `bun run verify` for the full workspace check.',
  ],
});

new TextFile(root, 'docs/llm/UTILITIES.md', {
  lines: [
    '# Utility catalog',
    '',
    '- `scripts/process.ts`: shell-free child-process execution shared by release tooling.',
    '- `ReadonlyGeneratedFiles`: Projen mixin that makes every synthesized file read-only across the project tree.',
    '- `PackageMetadata`: emits tracked, read-only `_generated/metadata.ts` modules and merges public `./metadata` package exports.',
    '- `createPyPackage`: creates uv packages from native Projen project metadata.',
    '- `pythonPackages`: discovers uv packages from the Projen subproject tree.',
    '- `scripts/workspaces.ts`: Pacwich-backed workspace discovery and shared-version validation.',
    '- `scripts/release-lib.ts`: pure SemVer, tag, GitHub remote, and identity helpers.',
    '- `scripts/release.ts`: local fixed-version release transaction.',
    '- `scripts/release-check.ts`: tag-workflow and registry preflight.',
    '- Bun runs each generated `pack:release` package script across the workspace.',
    '- Pacwich runs each generated `publish:release` package script in workspace dependency order.',
    '- `.github/workflows/publish.yml`: publishes npm and matrix-configured PyPI packages, then creates one GitHub Release after every publisher succeeds.',
    '',
    'Project metadata, dependency versions, TypeScript configuration, tasks, and GitHub workflows belong in `.projenrc.ts`.',
  ],
});

const githubComponent = root.github;
if (!githubComponent) throw new Error('GitHub integration must be enabled.');
const pypiProjectSpecs = pythonPackages()
  .filter(uv => uv.project.tasks.tryFind('publish'))
  .map(uv => ({
    distribution: uv.project.name,
    project_directory: projectRelativePath(uv.project),
    artifact: uv.project.name,
  }));
const pypiProjects = pypiProjectSpecs.map(project => ({
  ...project,
  environment: pypiProjectSpecs.length === 1
    ? 'pypi'
    : `pypi-${project.distribution}`,
}));
const workflowReleaseRef = '${{ inputs.release_tag || github.ref }}';
const workflowReleaseTag = '${{ inputs.release_tag || github.ref_name }}';
const publish = new github.GithubWorkflow(githubComponent, 'Publish', {
  fileName: 'publish.yml',
  limitConcurrency: true,
  concurrencyOptions: {
    group: 'publish-${{ inputs.release_tag || github.ref }}',
    cancelInProgress: false,
  },
});
publish.on({
  push: { tags: ['v*.*.*'] },
  workflowDispatch: {
    inputs: {
      release_tag: {
        description: 'Existing release tag to recover without republishing PyPI',
        required: true,
        type: 'string',
      },
    },
  },
});
publish.addJob('publish-npm', {
  name: 'Publish packages',
  runsOn: ['ubuntu-latest'],
  if: `github.repository == '${GITHUB_REPOSITORY}'`,
  environment: 'npm',
  timeoutMinutes: 30,
  permissions: {
    contents: github.workflows.JobPermission.READ,
    idToken: github.workflows.JobPermission.WRITE,
  },
  steps: [
    github.WorkflowSteps.checkout({ with: { ref: workflowReleaseRef } }),
    {
      name: 'Setup Node.js',
      uses: github.ActionRefs.ACTIONS_SETUP_NODE,
      with: {
        'node-version': '24',
        'package-manager-cache': false,
      },
    },
    ...root.renderWorkflowSetup(),
    {
      name: 'Setup uv',
      uses: SETUP_UV_ACTION,
      with: { version: 'latest-known' },
    },
    {
      name: 'Install a trusted-publishing npm version',
      run: 'npm install --global npm@11.20.0',
    },
    {
      name: 'Validate the release tag',
      if: "github.event_name == 'push'",
      run: `bun run release:check -- "${workflowReleaseTag}" --npm-only`,
    },
    {
      name: 'Validate the recovery tag',
      if: "github.event_name == 'workflow_dispatch'",
      env: { RELEASE_TAG: workflowReleaseTag },
      run: [
        'project_tag="v$(node -p "require(\'./package.json\').version")"',
        'test "$project_tag" = "$RELEASE_TAG" || { echo "Expected $project_tag, received $RELEASE_TAG."; exit 1; }',
      ].join('\n'),
    },
    {
      name: 'Build the tagged source',
      run: 'bun run build',
    },
    {
      name: 'Publish the generated archives',
      run: 'bun run publish:release',
    },
    github.WorkflowSteps.uploadArtifact({
      name: 'Upload published npm archives',
      with: {
        name: 'npm-packages',
        path: 'dist/packages/*.tgz',
        ifNoFilesFound: 'error',
        retentionDays: 7,
      },
    }),
  ],
});

publish.addJob('publish-pypi', {
  name: 'Publish ${{ matrix.distribution }}',
  runsOn: ['ubuntu-latest'],
  if: `github.repository == '${GITHUB_REPOSITORY}'`,
  environment: '${{ matrix.environment }}',
  strategy: {
    failFast: false,
    matrix: {
      include: pypiProjects.map((project) => ({ ...project })),
    },
  },
  timeoutMinutes: 10,
  permissions: {
    contents: github.workflows.JobPermission.READ,
    idToken: github.workflows.JobPermission.WRITE,
  },
  steps: [
    github.WorkflowSteps.checkout({ with: { ref: workflowReleaseRef } }),
    {
      name: 'Setup uv',
      uses: SETUP_UV_ACTION,
      with: { version: 'latest-known' },
    },
    {
      name: 'Validate the release tag',
      env: {
        PROJECT_DIRECTORY: '${{ matrix.project_directory }}',
        RELEASE_TAG: workflowReleaseTag,
      },
      run: [
        'project_tag="v$(uv version --project "$PROJECT_DIRECTORY" --short)"',
        'test "$project_tag" = "$RELEASE_TAG" || { echo "Expected $project_tag, received $RELEASE_TAG."; exit 1; }',
      ].join('\n'),
    },
    {
      name: 'Build the Python distribution',
      env: {
        DISTRIBUTION_DIRECTORY: '${{ matrix.project_directory }}/dist/py',
        PROJECT_DIRECTORY: '${{ matrix.project_directory }}',
      },
      run: 'uv build --project "$PROJECT_DIRECTORY" --out-dir "$DISTRIBUTION_DIRECTORY" --no-sources',
    },
    {
      name: 'Publish the Python distribution',
      if: "github.event_name == 'push'",
      env: {
        DISTRIBUTION_DIRECTORY: '${{ matrix.project_directory }}/dist/py',
      },
      run: 'uv publish --trusted-publishing always "$DISTRIBUTION_DIRECTORY"/*',
    },
    github.WorkflowSteps.uploadArtifact({
      name: 'Upload published Python distributions',
      with: {
        name: 'python-package-${{ matrix.artifact }}',
        path: '${{ matrix.project_directory }}/dist/py/*',
        ifNoFilesFound: 'error',
        retentionDays: 7,
      },
    }),
  ],
});

publish.addJob('release', {
  name: 'Create GitHub release',
  runsOn: ['ubuntu-latest'],
  needs: ['publish-npm', 'publish-pypi'],
  if: `success() && github.repository == '${GITHUB_REPOSITORY}'`,
  timeoutMinutes: 10,
  permissions: {
    contents: github.workflows.JobPermission.WRITE,
  },
  steps: [
    github.WorkflowSteps.downloadArtifact({
      name: 'Download published npm archives',
      with: {
        name: 'npm-packages',
        path: '${{ runner.temp }}/release/npm',
      },
    }),
    github.WorkflowSteps.downloadArtifact({
      name: 'Download published Python distributions',
      with: {
        pattern: 'python-package-*',
        path: '${{ runner.temp }}/release/python',
        mergeMultiple: true,
      },
    }),
    {
      name: 'Create GitHub release',
      env: {
        GH_REPO: '${{ github.repository }}',
        GH_TOKEN: '${{ github.token }}',
        RELEASE_DIR: '${{ runner.temp }}/release',
        RELEASE_TAG: workflowReleaseTag,
      },
      run: [
        'if gh release view "$RELEASE_TAG" >/dev/null 2>&1; then',
        '  is_draft="$(gh release view "$RELEASE_TAG" --json isDraft --jq .isDraft)"',
        '  if [[ "$is_draft" != "true" ]]; then',
        '    echo "GitHub release $RELEASE_TAG already exists."',
        '    exit 0',
        '  fi',
        'else',
        '  gh release create "$RELEASE_TAG" --draft --verify-tag --generate-notes --title "$RELEASE_TAG"',
        'fi',
        'gh release upload "$RELEASE_TAG" "$RELEASE_DIR"/npm/*.tgz "$RELEASE_DIR"/python/* --clobber',
        'gh release edit "$RELEASE_TAG" --draft=false',
      ].join('\n'),
    },
  ],
});
publish.file?.addOverride('permissions', { contents: 'none' });

function replaceBuildDependencies(
  project: javascript.NodeProject,
  dependencies: readonly string[],
): void {
  for (const name of ['@types/node', 'constructs', 'projen', 'typescript']) {
    if (project.deps.tryGetDependency(name, DependencyType.BUILD)) {
      project.deps.removeDependency(name, DependencyType.BUILD);
    }
  }
  project.addDevDeps(...dependencies);
}

function gitOriginUrl(): string | undefined {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: new URL('.', import.meta.url),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function githubRepositoryFromRemote(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  return /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|(?:git\+)?https:\/\/github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/iu
    .exec(remote.trim())?.[1];
}

function configureScriptTypes(
  project: typescript.TypeScriptProject,
  rootDir = '..',
): void {
  new javascript.TypescriptConfig(project, {
    fileName: 'scripts/tsconfig.json',
    extends: javascript.TypescriptConfigExtends.fromTypescriptConfigs([project.tsconfig!]),
    compilerOptions: {
      allowImportingTsExtensions: true,
      noEmit: true,
      rootDir,
    },
    include: ['**/*.ts'],
    exclude: ['../dist', '../node_modules'],
  });
}

function configureTypecheck(
  project: typescript.TypeScriptProject,
  commands: readonly (readonly string[])[],
): void {
  const task = project.tasks.tryFind('typecheck') ?? project.addTask('typecheck', {
    description: `Type-check ${project.name}.`,
  });
  task.reset();
  for (const command of commands) task.execArgs([...command]);

  const packageVerify = project.tasks.tryFind('verify') ?? project.addTask('verify', {
    description: `Build, type-check, and test ${project.name}.`,
  });
  packageVerify.reset();
  packageVerify.spawn(project.compileTask);
  packageVerify.spawn(task);
  packageVerify.spawn(project.testTask);
}

root.with(new ReadonlyGeneratedFiles());
root.synth();
