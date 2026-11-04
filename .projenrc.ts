import { execFileSync } from 'node:child_process';
import type { IConstruct, IMixin } from 'constructs';
import {
  Component,
  DependencyType,
  Project,
  TextFile,
  github,
  javascript,
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

const VERSION = '0.8.3';
const BUN_VERSION = '1.4.4';
const PROJEN_VERSION = '0.104.23';
const SETUP_UV_ACTION = 'astral-sh/setup-uv@68559e99cc807c1eb7e9238fd43a15bba460eec2';
const BOOTSTRAP_GITHUB_REPOSITORY = 'regbo/lfp-js';
const GITHUB_REPOSITORY = githubRepositoryFromRemote(gitOriginUrl())
  ?? BOOTSTRAP_GITHUB_REPOSITORY;
const GITHUB_URL = `https://github.com/${GITHUB_REPOSITORY}`;
const REPOSITORY = `${GITHUB_URL}.git`;
const BUGS_URL = `${GITHUB_URL}/issues`;

/** The only source of external dependency versions for every workspace. */
const CATALOG = {
  '@antfu/install-pkg': '^2.1.0',
  '@msgpack/msgpack': '^3.1.2',
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
  name: 'lfp-js',
  description: 'LFP Connect JavaScript and TypeScript libraries.',
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
  description: 'Lazy uv-backed Python environments with object proxies for Node.js and Bun.',
  srcdir: 'src',
  libdir: 'dist/js',
  authorName: 'Reggie Bowser and NodePyX contributors',
  tsconfig: {
    compilerOptions: {
      module: 'CommonJS',
      lib: ['ES2022', 'ESNext.Disposable'],
    },
  },
  bin: { pynect: 'dist/js/cli.mjs' },
  deps: [
    '@msgpack/msgpack@catalog:',
    'loqkit@workspace:*',
    'optionkit@workspace:*',
    'pyfig@workspace:*',
    'smol-toml@catalog:',
    'zod@catalog:',
  ],
  keywords: ['python', 'nodejs', 'bun', 'typescript', 'pydantic', 'uv', 'ipc', 'named-pipe'],
});
pynect.addFields({
  main: 'dist/js/index.js',
  types: 'dist/js/index.d.ts',
  bin: { pynect: 'dist/js/cli.mjs' },
  exports: {
    '.': {
      types: './dist/js/index.d.ts',
      import: './dist/js/index.js',
      require: './dist/js/index.js',
    },
    './types': {
      types: './dist/js/types/index.d.ts',
      import: './dist/js/types/index.js',
      require: './dist/js/types/index.js',
    },
  },
  files: ['dist/', 'README.md', 'SECURITY.md', 'LICENSE'],
  engines: {
    node: '^22.11.0 || >=24.10.0 <=26.x',
    bun: '>=1.2.0',
  },
});
pynect.compileTask.reset();
pynect.compileTask.execArgs(['bun', 'scripts/build-typescript.js']);
configureTestsAndTypecheck(pynect, [
  ['tsc', '--noEmit', '-p', 'tsconfig.json'],
  ['tsc', '--noEmit', '-p', 'tests/tsconfig.json'],
  ['uv', 'run', '--locked', 'ruff', 'check', 'scripts'],
  ['uv', 'run', '--locked', 'ruff', 'format', '--check', 'scripts'],
]);
pynect.addTask('check:python', {
  execArgs: ['uv', 'run', '--locked', 'ruff', 'check', 'scripts'],
});
pynect.addTask('format:python', {
  execArgs: ['uv', 'run', '--locked', 'ruff', 'format', 'scripts'],
});
pynect.addTask('format:python:check', {
  execArgs: ['uv', 'run', '--locked', 'ruff', 'format', '--check', 'scripts'],
});
pynect.addTask('test:smoke', {
  description: 'Run opt-in Pynect I/O and startup smoke benchmarks.',
  execArgs: ['bun', 'test', './tests/io.smoke.ts'],
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
    '# lfp-js',
    '',
    'The shared Bun monorepo for LFP Connect JavaScript and TypeScript libraries.',
    '',
    '| Package | Purpose |',
    '| --- | --- |',
    '| [`loqkit`](packages/loqkit) | Typed memoization and layered locks. |',
    '| [`optionkit`](packages/optionkit) | Zod-backed CLI configuration. |',
    '| [`pyfig`](packages/pyfig) | uv bootstrap and Python execution. |',
    '| [`pynect`](packages/pynect) | Lazy Python environments and object proxies. |',
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
    '- `scripts/workspaces.ts`: Pacwich-backed workspace discovery and shared-version validation.',
    '- `scripts/release-lib.ts`: pure SemVer, tag, GitHub remote, and identity helpers.',
    '- `scripts/release.ts`: local fixed-version release transaction.',
    '- `scripts/release-check.ts`: tag-workflow and registry preflight.',
    '- Bun runs each generated `pack:release` package script across the workspace.',
    '- Pacwich runs each generated `publish:release` package script in workspace dependency order.',
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
    contents: github.workflows.JobPermission.WRITE,
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
    {
      name: 'Create GitHub release',
      env: { GH_TOKEN: '${{ github.token }}' },
      run: 'gh release create "${{ github.ref_name }}" dist/packages/*.tgz --verify-tag --generate-notes --title "${{ github.ref_name }}"',
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
