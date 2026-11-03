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

const VERSION = '0.8.0';
const BUN_VERSION = '1.4.4';
const PROJEN_VERSION = '0.104.23';
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
  fileName: 'tsconfig.scripts.json',
  extends: javascript.TypescriptConfigExtends.fromTypescriptConfigs([baseTsconfig]),
  compilerOptions: {
    allowImportingTsExtensions: true,
    declaration: false,
    declarationMap: false,
    noEmit: true,
    rootDir: '.',
    inlineSources: false,
    sourceMap: false,
    types: ['bun', 'node'],
  },
  include: ['scripts/**/*.ts', 'tests/**/*.ts'],
  exclude: ['dist', 'node_modules', 'packages'],
});

replaceBuildDependencies(root, [
  '@types/bun@catalog:',
  '@types/node@catalog:',
  '@types/semver@catalog:',
  'constructs@catalog:',
  'projen@catalog:',
  'semver@catalog:',
  'tar@catalog:',
  'typescript@catalog:',
]);

interface WorkspaceOptions {
  readonly name: 'loqkit' | 'optionkit' | 'pyfig' | 'pynect';
  readonly description: string;
  readonly srcdir: string;
  readonly libdir: string;
  readonly testdir: string;
  readonly copyrightOwner: string;
  readonly module?: string;
  readonly moduleResolution?: javascript.TypeScriptModuleResolution;
  readonly lib?: string[];
  readonly exactOptionalPropertyTypes?: boolean;
  readonly entrypoint: string;
  readonly entrypointTypes: string;
  readonly bin?: Record<string, string>;
  readonly deps?: string[];
  readonly devDeps?: string[];
  readonly peerDeps?: string[];
  readonly keywords: string[];
}

function workspace(options: WorkspaceOptions): typescript.TypeScriptProject {
  const outdir = `packages/${options.name}`;
  const project = new typescript.TypeScriptProject({
    parent: root,
    outdir,
    name: options.name,
    packageName: options.name,
    description: options.description,
    authorName: options.copyrightOwner,
    defaultReleaseBranch: 'main',
    repository: REPOSITORY,
    repositoryDirectory: outdir,
    homepage: `${GITHUB_URL}/tree/main/${outdir}#readme`,
    bugsUrl: BUGS_URL,
    license: 'MIT',
    copyrightOwner: options.copyrightOwner,
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
    srcdir: options.srcdir,
    libdir: options.libdir,
    testdir: options.testdir,
    entrypoint: options.entrypoint,
    entrypointTypes: options.entrypointTypes,
    autoDetectBin: false,
    bin: options.bin,
    keywords: options.keywords,
    deps: options.deps,
    devDeps: options.devDeps,
    peerDeps: options.peerDeps,
    peerDependencyOptions: {
      pinnedDevDependency: false,
    },
    typescriptVersion: CATALOG.typescript,
    tsconfig: {
      extends: javascript.TypescriptConfigExtends.fromTypescriptConfigs([baseTsconfig]),
      compilerOptions: {
        rootDir: options.srcdir,
        outDir: options.libdir,
        declaration: true,
        declarationMap: true,
        sourceMap: true,
        inlineSourceMap: false,
        inlineSources: true,
        target: 'ES2022',
        lib: options.lib ?? ['ES2022'],
        experimentalDecorators: false,
        noEmitOnError: true,
        noUnusedLocals: false,
        noUnusedParameters: false,
        stripInternal: false,
        exactOptionalPropertyTypes: options.exactOptionalPropertyTypes,
        module: options.module ?? 'NodeNext',
        moduleResolution: options.moduleResolution
          ?? javascript.TypeScriptModuleResolution.NODE_NEXT,
        types: ['node'],
        verbatimModuleSyntax: options.module === 'CommonJS' ? false : true,
      },
      include: [`${options.srcdir}/**/*.ts`, `${options.srcdir}/**/*.mts`],
      exclude: ['dist', 'release', 'node_modules', options.testdir],
    },
    tsconfigDev: {
      compilerOptions: {
        allowImportingTsExtensions: true,
        module: options.module === 'CommonJS' ? 'ESNext' : undefined,
        moduleResolution: options.module === 'CommonJS'
          ? javascript.TypeScriptModuleResolution.BUNDLER
          : undefined,
        types: ['bun', 'node'],
      },
    },
  });

  project.package.addVersion(VERSION);
  project.addFields({
    sideEffects: false,
    publishConfig: {
      access: 'public',
      provenance: true,
      registry: 'https://registry.npmjs.org',
    },
  });
  project.addScripts({
    prepack: `bun ../../scripts/prepack.ts ${options.name}`,
  });
  replaceBuildDependencies(project, [
    '@types/bun@catalog:',
    '@types/node@catalog:',
    'typescript@catalog:',
    ...(options.devDeps ?? []),
  ]);

  return project;
}

const loqkit = workspace({
  name: 'loqkit',
  description: 'Typed memoization and layered memory, worker-thread, and file locks for JavaScript runtimes.',
  srcdir: 'src',
  libdir: 'release',
  testdir: 'test',
  copyrightOwner: 'Reggie Brooks',
  entrypoint: 'release/cjs/index.js',
  entrypointTypes: 'release/index.d.ts',
  exactOptionalPropertyTypes: true,
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
});
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
configureTestsAndTypecheck(loqkit, [
  ['tsc', '--noEmit', '-p', 'tsconfig.json'],
]);

const optionkit = workspace({
  name: 'optionkit',
  description: 'Turn Zod configuration schemas into zero-setup CLI options.',
  srcdir: 'src',
  libdir: 'dist',
  testdir: 'tests',
  copyrightOwner: 'optionkit contributors',
  entrypoint: 'dist/index.js',
  entrypointTypes: 'dist/index.d.ts',
  deps: ['@antfu/install-pkg@catalog:'],
  devDeps: [
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
new javascript.TypescriptConfig(optionkit, {
  fileName: 'tsconfig.scripts.json',
  extends: javascript.TypescriptConfigExtends.fromTypescriptConfigs([optionkit.tsconfig!]),
  compilerOptions: {
    allowImportingTsExtensions: true,
    declaration: false,
    declarationMap: false,
    noEmit: true,
    rootDir: '.',
    inlineSources: false,
    sourceMap: false,
    types: ['bun', 'node'],
  },
  include: ['scripts/**/*.ts'],
  exclude: ['dist', 'node_modules'],
});
optionkit.compileTask.reset();
optionkit.compileTask.execArgs(['bun', 'scripts/build.ts']);
optionkit.testTask.reset();
optionkit.testTask.execArgs(['bun', 'scripts/generate-catalog.ts']);
optionkit.testTask.execArgs(['bun', 'test']);
configureTypecheck(optionkit, [
  ['bun', 'scripts/generate-catalog.ts'],
  ['tsc', '--noEmit', '-p', 'tsconfig.json'],
  ['tsc', '--noEmit', '-p', 'tsconfig.scripts.json'],
  ['tsc', '--noEmit', '-p', 'tests/tsconfig.json'],
]);
optionkit.addTask('test:packed', {
  description: 'Smoke-test the packed package in an isolated consumer.',
  execArgs: ['bun', 'scripts/test-packed.ts'],
});

const pyfig = workspace({
  name: 'pyfig',
  description: 'Bootstrap uv and delegate Python execution to it.',
  srcdir: 'src',
  libdir: 'dist',
  testdir: 'tests',
  copyrightOwner: 'Reggie Bowser',
  entrypoint: 'dist/cjs/index.js',
  entrypointTypes: 'dist/index.d.ts',
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
});
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
new javascript.TypescriptConfig(pyfig, {
  fileName: 'tsconfig.scripts.json',
  extends: javascript.TypescriptConfigExtends.fromTypescriptConfigs([pyfig.tsconfig!]),
  compilerOptions: {
    allowImportingTsExtensions: true,
    declaration: false,
    declarationMap: false,
    noEmit: true,
    rootDir: '.',
    inlineSources: false,
    sourceMap: false,
    types: ['bun', 'node'],
  },
  include: ['scripts/**/*.ts'],
  exclude: ['dist', 'node_modules'],
});
pyfig.compileTask.reset();
pyfig.compileTask.execArgs(['bun', 'scripts/build.ts']);
configureTestsAndTypecheck(pyfig, [
  ['tsc', '--noEmit', '-p', 'tsconfig.json'],
  ['tsc', '--noEmit', '-p', 'tsconfig.scripts.json'],
  ['tsc', '--noEmit', '-p', 'tests/tsconfig.json'],
]);
pyfig.addScripts({ pyfig: 'bun ./src/cli.ts' });

const pynect = workspace({
  name: 'pynect',
  description: 'Lazy uv-backed Python environments with object proxies for Node.js and Bun.',
  srcdir: 'src/js',
  libdir: 'dist/js',
  testdir: 'tests',
  copyrightOwner: 'Reggie Bowser and NodePyX contributors',
  module: 'CommonJS',
  moduleResolution: javascript.TypeScriptModuleResolution.NODE,
  lib: ['ES2022', 'ESNext.Disposable'],
  entrypoint: 'dist/js/index.js',
  entrypointTypes: 'dist/js/index.d.ts',
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
  os: ['linux', 'darwin', 'win32'],
  cpu: ['x64', 'arm64'],
  upstream: 'https://github.com/Brah-Timo/nodepyx',
});
pynect.compileTask.reset();
pynect.compileTask.execArgs(['bun', 'scripts/build-typescript.js']);
configureTestsAndTypecheck(pynect, [
  ['tsc', '--noEmit', '-p', 'tsconfig.json'],
  ['tsc', '--noEmit', '-p', 'tests/tsconfig.json'],
  ['uv', 'run', '--locked', 'ruff', 'check', 'src/py'],
  ['uv', 'run', '--locked', 'ruff', 'format', '--check', 'src/py'],
]);
pynect.addTask('check:python', {
  execArgs: ['uv', 'run', '--locked', 'ruff', 'check', 'src/py'],
});
pynect.addTask('format:python', {
  execArgs: ['uv', 'run', '--locked', 'ruff', 'format', 'src/py'],
});
pynect.addTask('format:python:check', {
  execArgs: ['uv', 'run', '--locked', 'ruff', 'format', '--check', 'src/py'],
});

const WORKSPACE_FILTER = './packages/*';

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
workspaceTypecheck.execArgs(['tsc', '--noEmit', '-p', 'tsconfig.projen.json']);
workspaceTypecheck.execArgs(['tsc', '--noEmit', '-p', 'tsconfig.scripts.json']);
workspaceTypecheck.execArgs(['bun', 'run', '--filter', WORKSPACE_FILTER, 'typecheck']);

const typecheck = root.addTask('typecheck', {
  description: 'Build workspace dependencies, then type-check the monorepo.',
});
typecheck.spawn(root.compileTask);
typecheck.spawn(workspaceTypecheck);

root.packageTask.reset();
root.packageTask.execArgs(['bun', 'scripts/pack-packages.ts', 'dist/packages']);

root.postCompileTask.spawn(workspaceTypecheck);

const verify = root.addTask('verify', {
  description: 'Synthesize, build, type-check, test, pack, and audit all workspaces.',
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
root.addTask('pack:release', {
  description: 'Pack and audit all publishable workspaces.',
  execArgs: ['bun', 'scripts/pack-packages.ts', 'dist/packages'],
});
root.addTask('publish:release', {
  description: 'Publish the already-audited archives using npm trusted publishing.',
  execArgs: ['bun', 'scripts/publish-packages.ts', 'dist/packages'],
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
    '- `scripts/workspaces.ts`: workspace inventory, locations, dependency-derived ordering, and manifest validation.',
    '- `scripts/archive.ts`: npm archive content, metadata, workspace-protocol, email, and secret audit.',
    '- `scripts/pack-packages.ts`: packs every workspace in dependency order and audits the exact tarballs.',
    '- `scripts/release-lib.ts`: pure SemVer, tag, GitHub remote, and identity helpers.',
    '- `scripts/release.ts`: local fixed-version release transaction.',
    '- `scripts/release-check.ts`: tag-workflow and registry preflight.',
    '- `scripts/prepack.ts`: fail-closed package lifecycle gate.',
    '- `scripts/publish-packages.ts`: publishes only the audited tarballs created by the pack step.',
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
  env: {
    LFP_JS_SKIP_PREPACK: '1',
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
      name: 'Install a trusted-publishing npm version',
      run: 'npm install --global npm@11.20.0',
    },
    {
      name: 'Validate the release tag',
      run: 'bun run release:check -- "${{ github.ref_name }}"',
    },
    {
      name: 'Build and audit the tagged source',
      run: 'bun run build',
    },
    {
      name: 'Publish the audited archives',
      run: 'bun run publish:release',
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
      cwd: import.meta.dirname,
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
