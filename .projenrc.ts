import { execFileSync } from 'node:child_process';
import type { IConstruct, IMixin } from 'constructs';
import {
  Component,
  DependencyType,
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

const VERSION = '0.8.7';
const BUN_VERSION = '1.4.4';
const PROJEN_VERSION = '0.104.23';
const SETUP_UV_ACTION = 'astral-sh/setup-uv@68559e99cc807c1eb7e9238fd43a15bba460eec2';
const BOOTSTRAP_GITHUB_REPOSITORY = 'regbo/lfp-common';
const GITHUB_REPOSITORY = githubRepositoryFromRemote(gitOriginUrl())
  ?? BOOTSTRAP_GITHUB_REPOSITORY;
const GITHUB_URL = `https://github.com/${GITHUB_REPOSITORY}`;
const REPOSITORY = `${GITHUB_URL}.git`;
const BUGS_URL = `${GITHUB_URL}/issues`;

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
  name: 'lfp-common',
  description: 'Shared libraries and Python integrations for LFP Connect.',
  authorName: 'LFP Connect contributors',
  defaultReleaseBranch: 'main',
  repository: REPOSITORY,
  homepage: `${GITHUB_URL}#readme`,
  bugsUrl: BUGS_URL,
  license: 'MIT',
  copyrightOwner: 'LFP Connect contributors',
  copyrightPeriod: '2026',
  packageManager: javascript.NodePackageManager.BUN,
  bunVersion: BUN_VERSION,
  entrypoint: '',
  projenrcJs: false,
  release: false,
  autoMerge: false,
  package: false,
  jest: false,
  depsUpgrade: false,
  buildWorkflow: true,
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
  workflowPackageCache: false,
  pullRequestTemplate: false,
  prettier: false,
  biome: false,
  addPackageManagerToDevEngines: false,
  deleteOrphanedLockFiles: false,
});

root.package.addVersion(VERSION);
root.addFields({
  private: true,
  type: 'module',
  packageManager: `bun@${BUN_VERSION}`,
  workspaces: {
    packages: ['packages/*'],
    catalog: CATALOG,
  },
});
for (const pattern of [
  '.venv/',
  '**/__pycache__/',
  '*.pyc',
  '*.tgz',
  'coverage/',
  'dist/',
  'packages/*/dist/',
  'packages/*/release/',
] as const) root.addGitIgnore(pattern);
root.tasks.removeTask('clobber');
root.tasks.removeTask('eject');

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

/** Synthesize the small Python adapter bundled with the Pynect npm package. */
class PynectPythonPackage extends Component {
  constructor(project: typescript.TypeScriptProject) {
    super(project);

    new python.PyprojectTomlFile(project, {
      project: {
        name: 'pynect-worker',
        version: VERSION,
        description: 'Chanx schema export and local IPC adapter for Pynect',
        readme: 'README.md',
        requiresPython: '>=3.11',
        license: 'MIT',
        authors: [{ name: 'Reggie Bowser and NodePyX contributors' }],
        classifiers: [
          'Development Status :: 4 - Beta',
          'Environment :: Console',
          'Programming Language :: Python :: 3',
          'Programming Language :: Python :: 3.11',
          'Programming Language :: Python :: 3.12',
          'Programming Language :: Python :: 3.13',
          'Programming Language :: Python :: 3.14',
          'Typing :: Typed',
        ],
        urls: {
          Homepage: `${GITHUB_URL}/tree/main/packages/pynect#readme`,
          Repository: REPOSITORY,
          Issues: BUGS_URL,
        },
        dependencies: ['chanx[fast_channels]>=2.14,<3'],
        scripts: {
          'pynect-ipc': 'pynect_worker.ipc:main',
          'pynect-schema': 'pynect_worker.schema:main',
        },
      },
      dependencyGroups: {
        dev: [
          'pytest>=9,<10',
          'ruff>=0.17,<1',
        ],
      },
      buildSystem: {
        requires: ['uv_build>=0.10.7,<0.11'],
        buildBackend: 'uv_build',
      },
      tool: {
        uv: {
          'build-backend': {
            'module-name': 'pynect_worker',
            'module-root': 'src/py',
          },
        },
        pytest: {
          ini_options: { testpaths: ['tests/py'] },
        },
        ruff: {
          exclude: ['src/py/pynect_worker/_generated'],
          'line-length': 120,
          'target-version': 'py311',
          src: ['src/py', 'tests/py'],
          lint: { select: ['E', 'F', 'I', 'UP', 'B', 'SIM'] },
        },
      },
    });

    new TextFile(project, 'src/py/pynect_worker/_generated/__init__.py', {
      committed: true,
      readonly: true,
      lines: ['"""Generated package metadata."""'],
    });
    new TextFile(project, 'src/py/pynect_worker/_generated/metadata.py', {
      committed: true,
      readonly: true,
      lines: [
        '"""Package identity synthesized from the shared Projen configuration."""',
        `PACKAGE_NAME = ${JSON.stringify('pynect-worker')}`,
        `PACKAGE_VERSION = ${JSON.stringify(VERSION)}`,
      ],
    });
  }
}

function workspace(
  options: typescript.TypeScriptProjectOptions,
  metadataRequirePath?: string,
) {
  const outdir = options.outdir ?? `packages/${options.name}`;
  const srcdir = options.srcdir ?? 'src';
  const libdir = options.libdir ?? 'dist';
  const testdir = options.testdir ?? 'tests';
  const module = options.tsconfig?.compilerOptions?.module ?? 'NodeNext';
  const commonJs = module === 'CommonJS';
  const project = new typescript.TypeScriptProject({
    defaultReleaseBranch: 'main',
    repository: REPOSITORY,
    homepage: `${GITHUB_URL}/tree/main/${outdir}#readme`,
    bugsUrl: BUGS_URL,
    license: 'MIT',
    authorName: 'LFP Connect contributors',
    copyrightPeriod: '2026',
    packageManager: javascript.NodePackageManager.BUN,
    bunVersion: BUN_VERSION,
    npmAccess: javascript.NpmAccess.PUBLIC,
    npmProvenance: true,
    npmTrustedPublishing: true,
    npmignoreEnabled: false,
    package: false,
    release: false,
    github: false,
    buildWorkflow: false,
    depsUpgrade: false,
    jest: false,
    eslint: false,
    prettier: false,
    biome: false,
    sampleCode: false,
    projenrcJs: false,
    pullRequestTemplate: false,
    vscode: false,
    addPackageManagerToDevEngines: false,
    deleteOrphanedLockFiles: false,
    entrypoint: `${libdir}/index.js`,
    entrypointTypes: `${libdir}/index.d.ts`,
    autoDetectBin: false,
    peerDependencyOptions: {
      pinnedDevDependency: false,
    },
    typescriptVersion: CATALOG.typescript,
    ...options,
    parent: root,
    outdir,
    repositoryDirectory: outdir,
    libdir,
    testdir,
    tsconfig: {
      ...options.tsconfig,
      extends: options.tsconfig?.extends
        ?? javascript.TypescriptConfigExtends.fromTypescriptConfigs([baseTsconfig]),
      compilerOptions: {
        rootDir: srcdir,
        outDir: libdir,
        declaration: true,
        declarationMap: true,
        sourceMap: true,
        inlineSourceMap: false,
        inlineSources: true,
        target: 'ES2022',
        lib: ['ES2022'],
        experimentalDecorators: false,
        noEmitOnError: true,
        noUnusedLocals: false,
        noUnusedParameters: false,
        stripInternal: false,
        exactOptionalPropertyTypes: options.tsconfig?.compilerOptions?.exactOptionalPropertyTypes,
        module,
        moduleResolution: commonJs
          ? javascript.TypeScriptModuleResolution.NODE
          : javascript.TypeScriptModuleResolution.NODE_NEXT,
        verbatimModuleSyntax: !commonJs,
        ...options.tsconfig?.compilerOptions,
      },
      include: options.tsconfig?.include ?? [`${srcdir}/**/*.ts`, `${srcdir}/**/*.mts`],
      exclude: options.tsconfig?.exclude ?? ['dist', 'release', 'node_modules', testdir],
    },
    tsconfigDev: {
      ...options.tsconfigDev,
      compilerOptions: {
        allowImportingTsExtensions: true,
        module: commonJs ? 'ESNext' : undefined,
        moduleResolution: commonJs
          ? javascript.TypeScriptModuleResolution.BUNDLER
          : undefined,
        ...options.tsconfigDev?.compilerOptions,
      },
    },
  });

  project.package.addVersion(VERSION);
  new PackageMetadata(project, {
    libdir,
    name: options.name,
    requirePath: metadataRequirePath ?? (commonJs
      ? `./${libdir}/_generated/metadata.js`
      : undefined),
    srcdir,
  });
  project.addFields({
    sideEffects: false,
    publishConfig: {
      access: 'public',
      provenance: true,
      registry: 'https://registry.npmjs.org',
    },
  });
  project.addScripts({
    'pack:release': 'bun pm pack --ignore-scripts --destination ../../dist/packages --quiet',
    'publish:release': `npm publish ../../dist/packages/${options.name}-${VERSION}.tgz --access public --tag latest --provenance`,
  });
  replaceBuildDependencies(project, [
    '@types/bun@catalog:',
    '@types/node@catalog:',
    'typescript@catalog:',
    ...(options.devDeps ?? []),
  ]);

  return project;
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

const loqkit = workspace({
  name: 'loqkit',
  description: 'Typed memoization and layered memory, worker-thread, and file locks for JavaScript runtimes.',
  libdir: 'release',
  testdir: 'test',
  authorName: 'Reggie Brooks',
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
}, './release/cjs/_generated/metadata.js');
loqkit.addFields({
  type: 'module',
  main: './release/cjs/index.js',
  types: './release/index.d.ts',
  exports: {
    '.': {
      types: './release/index.d.ts',
      import: './release/index.js',
      require: './release/cjs/index.js',
    },
  },
  files: ['release', 'src', 'README.md', 'LICENSE'],
  engines: { node: '>=20' },
  optionalDependencies: { 'fs-ext': 'catalog:' },
});
loqkit.compileTask.reset();
loqkit.compileTask.execArgs(['tsc', '-p', 'tsconfig.json']);
loqkit.compileTask.execArgs(['bun', 'scripts/build-cjs.ts']);
configureScriptTypes(loqkit);
configureTestsAndTypecheck(loqkit, [
  ['tsc', '--noEmit', '-p', 'tsconfig.json'],
  ['tsc', '--noEmit', '-p', 'scripts/tsconfig.json'],
]);

const optionkit = workspace({
  name: 'optionkit',
  description: 'Turn Zod configuration schemas into zero-setup CLI options.',
  authorName: 'optionkit contributors',
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
});
optionkit.addFields({
  type: 'module',
  main: './dist/index.js',
  types: './dist/index.d.ts',
  exports: {
    '.': {
      types: './dist/index.d.ts',
      import: './dist/index.js',
      default: './dist/index.js',
    },
  },
  files: ['dist/', 'LICENSE', 'README.md'],
  engines: { node: '>=18' },
  peerDependenciesMeta: {
    fireargs: { optional: true },
    zod: { optional: true },
  },
});
configureScriptTypes(optionkit);
optionkit.compileTask.reset();
optionkit.compileTask.execArgs(['bun', 'scripts/build.ts']);
optionkit.testTask.reset();
optionkit.testTask.execArgs(['bun', 'scripts/generate-catalog.ts']);
optionkit.testTask.execArgs(['bun', 'test']);
configureTypecheck(optionkit, [
  ['bun', 'scripts/generate-catalog.ts'],
  ['tsc', '--noEmit', '-p', 'tsconfig.json'],
  ['tsc', '--noEmit', '-p', 'scripts/tsconfig.json'],
  ['tsc', '--noEmit', '-p', 'tests/tsconfig.json'],
]);
optionkit.addTask('test:packed', {
  description: 'Smoke-test the packed package in an isolated consumer.',
  execArgs: ['bun', 'scripts/test-packed.ts'],
});

const pyfig = workspace({
  name: 'pyfig',
  description: 'Bootstrap uv and delegate Python execution to it.',
  authorName: 'Reggie Bowser',
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
}, './dist/cjs/_generated/metadata.js');
pyfig.addFields({
  type: 'module',
  main: './dist/cjs/index.js',
  types: './dist/index.d.ts',
  exports: {
    '.': {
      types: './dist/index.d.ts',
      import: './dist/index.js',
      require: './dist/cjs/index.js',
    },
    './cli': {
      types: './dist/cli.d.ts',
      import: './dist/cli.js',
    },
  },
  files: ['dist/', 'LICENSE', 'README.md', 'SECURITY.md'],
  engines: {
    node: '^22.11.0 || >=24.10.0 <=26.x',
    bun: '>=1.2.0',
  },
});
configureScriptTypes(pyfig);
pyfig.compileTask.reset();
pyfig.compileTask.execArgs(['bun', 'scripts/build.ts']);
configureTestsAndTypecheck(pyfig, [
  ['tsc', '--noEmit', '-p', 'tsconfig.json'],
  ['tsc', '--noEmit', '-p', 'scripts/tsconfig.json'],
  ['tsc', '--noEmit', '-p', 'tests/tsconfig.json'],
]);
pyfig.addScripts({ pyfig: 'bun ./src/cli.ts' });

const pynect = workspace({
  name: 'pynect',
  description: 'Generate Chanx TypeScript clients from Python and run them locally over IPC.',
  srcdir: 'src/js',
  libdir: 'dist/js',
  authorName: 'Reggie Bowser and NodePyX contributors',
  tsconfig: {
    compilerOptions: {
      module: 'NodeNext',
      lib: ['ES2022', 'ESNext.Disposable'],
    },
  },
  bin: { pynect: 'dist/js/cli.js' },
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
    'ipc',
    'named-pipe',
    'websocket',
  ],
});
pynect.addFields({
  type: 'module',
  main: 'dist/js/index.js',
  types: 'dist/js/index.d.ts',
  bin: { pynect: 'dist/js/cli.js' },
  exports: {
    '.': {
      types: './dist/js/index.d.ts',
      import: './dist/js/index.js',
      default: './dist/js/index.js',
    },
  },
  files: ['dist/', 'README.md', 'SECURITY.md', 'LICENSE'],
  engines: {
    node: '^22.11.0 || >=24.10.0 <=26.x',
    bun: '>=1.2.0',
  },
});
new PynectPythonPackage(pynect);
configureScriptTypes(pynect);
new javascript.TypescriptConfig(pynect, {
  fileName: 'example/tsconfig.json',
  extends: javascript.TypescriptConfigExtends.fromTypescriptConfigs([pynect.tsconfig!]),
  compilerOptions: {
    allowImportingTsExtensions: true,
    noEmit: true,
    rootDir: '..',
  },
  include: ['**/*.ts'],
  exclude: ['node_modules'],
});
pynect.gitattributes.addAttributes('/example/_generated/**', 'linguist-generated');
pynect.addScripts({
  'example:cli': 'bun example/cli.ts',
  'example:generate': 'bun src/js/cli.ts generate --root example',
  'example:local': 'bun example/local.ts',
  'example:remote': 'bun example/remote.ts',
  'example:serve': 'uv run --project example uvicorn --app-dir example server:app --host 127.0.0.1 --port 7777',
});
pynect.compileTask.reset();
pynect.compileTask.execArgs(['bun', 'src/js/cli.ts', 'generate', '--root', 'example']);
pynect.compileTask.execArgs(['bun', 'scripts/build.ts']);
configureTestsAndTypecheck(pynect, [
  ['tsc', '--noEmit', '-p', 'tsconfig.json'],
  ['tsc', '--noEmit', '-p', 'scripts/tsconfig.json'],
  ['tsc', '--noEmit', '-p', 'tests/tsconfig.json'],
  ['tsc', '--noEmit', '-p', 'example/tsconfig.json'],
  ['uv', 'run', '--locked', 'ruff', 'check', 'src/py', 'tests/py', 'example'],
  ['uv', 'run', '--locked', 'ruff', 'format', '--check', 'src/py', 'tests/py', 'example'],
]);
pynect.testTask.execArgs(['bun', 'example/local.ts']);
pynect.testTask.execArgs(['uv', 'run', '--locked', 'python', '-m', 'pytest']);
pynect.addTask('check:python', {
  execArgs: ['uv', 'run', '--locked', 'ruff', 'check', 'src/py', 'tests/py', 'example'],
});
pynect.addTask('format:python', {
  execArgs: ['uv', 'run', '--locked', 'ruff', 'format', 'src/py', 'tests/py', 'example'],
});
pynect.addTask('format:python:check', {
  execArgs: ['uv', 'run', '--locked', 'ruff', 'format', '--check', 'src/py', 'tests/py', 'example'],
});

const WORKSPACE_FILTER = './packages/*';
const PACWICH = ['bun', 'node_modules/pacwich/bin/cli.js'] as const;

root.compileTask.reset();
root.compileTask.execArgs(['bun', 'run', '--filter', WORKSPACE_FILTER, 'compile']);

root.testTask.reset();
root.testTask.execArgs([
  'bun',
  'test',
  'tests/monorepo.test.ts',
  'tests/release-lib.test.ts',
]);
root.testTask.execArgs(['bun', 'run', '--filter', WORKSPACE_FILTER, 'test']);

const workspaceTypecheck = root.addTask('typecheck:workspaces', {
  description: 'Type-check Projen, shared scripts, and built workspaces.',
});
workspaceTypecheck.execArgs([...PACWICH, 'verify', '--strict']);
workspaceTypecheck.execArgs(['tsc', '--noEmit', '-p', 'tsconfig.json']);
workspaceTypecheck.execArgs(['bun', 'run', '--filter', WORKSPACE_FILTER, 'typecheck']);

const typecheck = root.addTask('typecheck', {
  description: 'Build workspace dependencies, then type-check the monorepo.',
});
typecheck.spawn(root.compileTask);
typecheck.spawn(workspaceTypecheck);

root.packageTask.reset();
root.packageTask.execArgs(['bun', 'run', '--filter', WORKSPACE_FILTER, 'pack:release']);

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
    '| [`loqkit`](packages/loqkit) | Typed memoization and layered locks. |',
    '| [`optionkit`](packages/optionkit) | Zod-backed CLI configuration. |',
    '| [`pyfig`](packages/pyfig) | uv bootstrap and Python execution. |',
    '| [`pynect`](packages/pynect) | Python-owned Chanx APIs with generated TypeScript and local IPC. |',
    '',
    'All packages use the version declared in `.projenrc.ts`, external versions come from its Bun catalog, and sibling packages use `workspace:*`.',
    'Every workspace publishes its generated `PACKAGE_NAME` and `PACKAGE_VERSION` constants from the `./metadata` subpath.',
    '',
    'Run `bun run projen` after changing project configuration and `bun run verify` for the full workspace check.',
  ],
});

new TextFile(root, 'docs/llm/UTILITIES.md', {
  lines: [
    '# Utility catalog',
    '',
    '- `scripts/process.ts`: shell-free child-process execution shared by release tooling.',
    '- `ReadonlyGeneratedFiles`: Projen mixin that makes every synthesized file read-only across the project tree.',
    '- `PackageMetadata`: emits tracked, read-only `_generated/metadata.ts` modules and merges public `./metadata` package exports.',
    '- `PynectPythonPackage`: synthesizes Pynect\'s small Chanx schema/IPC Python adapter.',
    '- `scripts/workspaces.ts`: Pacwich-backed workspace discovery and shared-version validation.',
    '- `scripts/release-lib.ts`: pure SemVer, tag, GitHub remote, and identity helpers.',
    '- `scripts/release.ts`: local fixed-version release transaction.',
    '- `scripts/release-check.ts`: tag-workflow and registry preflight.',
    '- Bun runs each generated `pack:release` package script across the workspace.',
    '- Pacwich runs each generated `publish:release` package script in workspace dependency order.',
    '- `.github/workflows/publish-pypi.yml`: publishes `pynect-worker` with PyPI Trusted Publishing.',
    '',
    'Project metadata, dependency versions, TypeScript configuration, tasks, and GitHub workflows belong in `.projenrc.ts`.',
  ],
});

const githubComponent = root.github;
if (!githubComponent) throw new Error('GitHub integration must be enabled.');
const publish = new github.GithubWorkflow(githubComponent, 'Publish', {
  fileName: 'publish.yml',
  limitConcurrency: true,
  concurrencyOptions: {
    group: 'publish-${{ github.ref }}',
    cancelInProgress: false,
  },
});
publish.on({ push: { tags: ['v*.*.*'] } });
publish.addJob('publish', {
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
    github.WorkflowSteps.checkout(),
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
      run: 'bun run release:check -- "${{ github.ref_name }}"',
    },
    {
      name: 'Build the tagged source',
      run: 'bun run build',
    },
    {
      name: 'Publish the generated archives',
      run: 'bun run publish:release',
    },
  ],
});
publish.file?.addOverride('permissions', { contents: 'none' });

const publishPython = new github.GithubWorkflow(githubComponent, 'Publish Python', {
  fileName: 'publish-pypi.yml',
  limitConcurrency: true,
  concurrencyOptions: {
    group: 'publish-pypi-${{ github.ref }}',
    cancelInProgress: false,
  },
});
publishPython.on({
  push: { tags: ['v*.*.*'] },
  workflowDispatch: {
    inputs: {
      tag: {
        description: 'Release tag to publish',
        required: true,
        type: 'string',
      },
    },
  },
});
publishPython.addJob('publish', {
  name: 'Publish pynect-worker',
  runsOn: ['ubuntu-latest'],
  if: `github.repository == '${GITHUB_REPOSITORY}'`,
  environment: 'pypi',
  timeoutMinutes: 10,
  permissions: {
    contents: github.workflows.JobPermission.READ,
    idToken: github.workflows.JobPermission.WRITE,
  },
  steps: [
    github.WorkflowSteps.checkout({
      with: {
        ref: "${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}",
      },
    }),
    {
      name: 'Setup uv',
      uses: SETUP_UV_ACTION,
      with: { version: 'latest-known' },
    },
    {
      name: 'Validate the release tag',
      env: {
        RELEASE_TAG: "${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}",
      },
      run: [
        'project_tag="v$(uv version --project packages/pynect --short)"',
        'test "$project_tag" = "$RELEASE_TAG" || { echo "Expected $project_tag, received $RELEASE_TAG."; exit 1; }',
      ].join('\n'),
    },
    {
      name: 'Build the Python distribution',
      run: 'uv build --project packages/pynect --out-dir packages/pynect/dist/py --no-sources',
    },
    {
      name: 'Publish the Python distribution',
      run: 'uv publish --trusted-publishing always packages/pynect/dist/py/*',
    },
  ],
});
publishPython.file?.addOverride('permissions', { contents: 'none' });

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

function configureTestsAndTypecheck(
  project: typescript.TypeScriptProject,
  commands: readonly string[][],
): void {
  project.testTask.reset();
  project.testTask.execArgs(['bun', 'test']);
  configureTypecheck(project, commands);
}

function configureScriptTypes(project: typescript.TypeScriptProject): void {
  new javascript.TypescriptConfig(project, {
    fileName: 'scripts/tsconfig.json',
    extends: javascript.TypescriptConfigExtends.fromTypescriptConfigs([project.tsconfig!]),
    compilerOptions: {
      allowImportingTsExtensions: true,
      noEmit: true,
      rootDir: '..',
    },
    include: ['**/*.ts'],
    exclude: ['../dist', '../node_modules'],
  });
}

function configureTypecheck(
  project: typescript.TypeScriptProject,
  commands: readonly string[][],
): void {
  const task = project.addTask('typecheck', {
    description: `Type-check ${project.name}.`,
  });
  for (const command of commands) task.execArgs([...command]);

  const packageVerify = project.addTask('verify', {
    description: `Build, type-check, and test ${project.name}.`,
  });
  packageVerify.spawn(project.compileTask);
  packageVerify.spawn(task);
  packageVerify.spawn(project.testTask);
}

root.with(new ReadonlyGeneratedFiles());
root.synth();
