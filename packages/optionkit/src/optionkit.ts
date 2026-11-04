import { constants } from 'node:fs';
import { access, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectPackageManager, installPackage } from '@antfu/install-pkg';
import { valid as validSemver } from 'semver';
import type {
  ZodArray,
  ZodBoolean,
  ZodNumber,
  ZodObject,
  ZodReadonly,
  ZodString,
  ZodType,
} from 'zod';
import { catalog } from './_generated/catalog.js';
import { importPackageIfAvailable, resolvePackage } from './resolve.js';

type CliAdapterModule = typeof import('fireargs');
type ErrorFormatterModule = Readonly<Record<string, unknown>>;
type StackFormatter = (stack: string, options?: { pretty?: boolean }) => unknown;
type ZodNamespace = typeof import('zod').z;
type ZodShape = Record<string, ZodType>;
type StructuredValueKind = 'array' | 'object';
type InternalValueParser = (value: string) => never;
type ObjectSchema = ZodObject<ZodShape> | ZodReadonly<ZodObject<ZodShape>>;
type SchemaInput<Schema extends ZodType> = import('zod').input<Schema>;
type SchemaOutput<Schema extends ZodType> = import('zod').output<Schema>;

export interface OptionConfiguration<Value = unknown> {
  /** Long flag without dashes. Defaults to the kebab-case field key. */
  name?: string;
  /** Override the generated environment variable, or disable it for this field. */
  env?: string | false;
  /** Override the generated short flag, or disable it for this field. */
  short?: string | false;
  conflicts?: string | string[];
  implies?: Record<string, unknown>;
  hidden?: boolean;
  preset?: unknown;
  helpGroup?: string;
  defaultDescription?: string;
  /** Fireargs parser for one CLI or environment string; disables automatic decoding. */
  parse?: (value: string) => Value;
}

export interface ArgumentConfiguration<Value = unknown> {
  name?: string;
  defaultDescription?: string;
  parse?: (value: string) => Value;
}

export interface PassThroughArgumentsConfiguration {
  /** Help text for the generated trailing `args` positional. */
  description?: string;
}

export interface CommandConfiguration extends Record<string, unknown> {
  /** Add a typed trailing `args` array and the Fireargs pass-through switches. */
  passThroughArguments?: boolean | PassThroughArgumentsConfiguration;
}
export type ProgramConfiguration = Record<string, unknown>;

export interface CliParseOptions {
  from?: 'electron' | 'node' | 'user';
}

export interface CliRoute {
  readonly type: 'command' | 'program';
  helpInformation(): string;
  parseAsync(argv?: readonly string[], options?: CliParseOptions): Promise<unknown>;
}

export interface CliCommand extends CliRoute {
  readonly type: 'command';
}

export interface CliProgram extends CliRoute {
  readonly type: 'program';
}

export interface CommandContext {
  readonly command: CliCommand;
  readonly json: boolean;
}

export interface RenderContext<Input> {
  readonly command: CliCommand;
  readonly input: Input;
  readonly json: false;
}

export interface FieldBuilder<Value = never> {
  string(): ZodString;
  number(): ZodNumber;
  boolean(): ZodBoolean;
  enum<const Values extends readonly [string, ...string[]]>(values: Values): ZodType<Values[number]>;
  array<Inner extends ZodType>(inner: Inner): ZodArray<Inner>;
  schema<Schema extends ZodType>(schema: Schema): Schema;
}

interface HandlerBuilder<Input, Output extends ZodType> {
  handler(
    handler: (
      input: Input,
      context: CommandContext,
    ) => SchemaInput<Output> | Promise<SchemaInput<Output>>,
  ): CliCommand;
}

interface OutputBuilder<Input, Output extends ZodType>
  extends HandlerBuilder<Input, Output> {
  render(
    render: (
      output: SchemaOutput<Output>,
      context: RenderContext<Input>,
    ) => string | void | Promise<string | void>,
  ): HandlerBuilder<Input, Output>;
}

interface CommandBuilder<PassThrough extends boolean> {
  input<Input extends ObjectSchema>(schema: Input): {
    output<Output extends ZodType>(schema: Output): OutputBuilder<
      PassThrough extends true
        ? SchemaOutput<Input> & { args: string[] }
        : SchemaOutput<Input>,
      Output
    >;
  };
}

export interface OptionKitAdapter {
  argument<Value = never>(configuration?: ArgumentConfiguration<Value>): FieldBuilder<Value>;
  command(
    configuration: CommandConfiguration & {
      passThroughArguments: true | PassThroughArgumentsConfiguration;
    },
  ): CommandBuilder<true>;
  command(configuration?: CommandConfiguration): CommandBuilder<false>;
  option<Value = never>(configuration?: OptionConfiguration<Value>): FieldBuilder<Value>;
  program(configuration?: ProgramConfiguration): {
    router(routes: Readonly<Record<string, CliRoute>>): CliProgram;
  };
}

type ResolvedOptionConfiguration = Omit<OptionConfiguration<never>, 'env' | 'short'> & {
  env?: string;
  /** Internal compatibility parser for structured values carried by one env string. */
  parse?: InternalValueParser;
  short?: string;
};

interface StructuredEnvironmentBinding {
  readonly env: string;
  readonly name: string;
  readonly short?: string;
}

interface OptionNegation {
  readonly name: string;
}

interface RuntimeOption {
  readonly long?: string;
}

interface VersionedRuntimeRoute extends CliRoute {
  readonly options?: readonly RuntimeOption[];
  readonly parent: unknown | null;
  version(value: string, flags?: string, description?: string): unknown;
}

interface RuntimeCliCommand extends CliCommand {
  readonly options?: readonly RuntimeOption[];
  configureOutput?: () => { writeErr?: (value: string) => void };
  option?: (flags: string, description?: string) => RuntimeCliCommand;
}

interface RuntimeRoute extends CliRoute {
  readonly commands?: readonly RuntimeRoute[];
  name?: () => string;
  aliases?: () => string[];
}

export type OptionKitLogger = (
  message: string,
  details?: Readonly<Record<string, unknown>>,
) => void;

export interface ErrorFormatterPackage {
  /** Package name imported at runtime. */
  name: string;
  /** Package specifier passed to install-pkg. Defaults to `name`. */
  specifier?: string;
}

export interface CreateOptionKitSettings {
  /** Module URL for the consuming CLI; used to find its nearest package.json. */
  moduleUrl?: string | URL;
  /** Explicit consuming package root when moduleUrl discovery is not appropriate. */
  packageRoot?: string;
  /** Override the consuming package name used to derive the environment prefix. */
  projectName?: string;
  /** Add `-v, --version` from an explicit SemVer supplied by the CLI package. */
  version?: string | false;
  /** Override the generated prefix, or disable environment bindings. */
  environmentPrefix?: string | false;
  /** Generate non-conflicting single-letter flags. Defaults to true. */
  shortFlags?: boolean;
  /** Add `--no-*` twins for boolean options. Defaults to true. */
  booleanNegations?: boolean;
  /** Letters that automatic short-flag generation must not use. */
  reservedShortFlags?: readonly string[];
  /** Per-field CLI metadata applied after generated values. */
  fields?: Readonly<Record<string, OptionConfiguration>>;
  /** Working directory used to detect the caller's package manager. */
  invocationDirectory?: string;
  /** Explicit isolated install directory. By default, missing packages install at packageRoot. */
  cacheDirectory?: string;
  /** Optional diagnostics sink. optionkit never writes install progress itself. */
  log?: OptionKitLogger;
  /** Best-effort stack formatter package. Defaults to the catalog's clean-stack. */
  errorFormatter?: string | ErrorFormatterPackage | false;
  /** Format rejected handlers and renderers at the parse boundary. Defaults to true. */
  formatErrors?: boolean;
}

export interface OptionKit {
  /** CLI builder namespace, loaded from the project or the lazy cache. */
  f: OptionKitAdapter;
  /** Zod from the same dependency location as the CLI adapter. */
  z: ZodNamespace;
  /** Prefix used for generated environment variables, including its trailing underscore. */
  environmentPrefix: string | false;
  /** The consuming package root discovered for this CLI. */
  packageRoot: string;
  /** Where the CLI dependencies were resolved or installed. */
  dependencySource: 'cache' | 'package-root' | 'project';
  /** Render an error with the optional formatter when it is available. */
  formatError: (error: unknown) => string;
}

const REQUIRED_CLI_DEPENDENCY_SPECIFIERS = [
  `fireargs@${catalog.fireargs}`,
  `zod@${catalog.zod}`,
];
const DEFAULT_ERROR_FORMATTER = {
  name: 'clean-stack',
  specifier: `clean-stack@${catalog['clean-stack']}`,
} as const satisfies ErrorFormatterPackage;
const installPromises = new Map<string, Promise<LoadedDependencies>>();
const formatterPromises = new Map<string, Promise<StackFormatter | undefined>>();

/**
 * Load the CLI adapter on demand. Every command input is transparently augmented
 * with environment bindings and conflict-free short flags.
 */
export async function createOptionKit(
  settings: CreateOptionKitSettings = {},
): Promise<OptionKit> {
  const packageInfo = await consumingPackage(settings);
  const version = resolvePackageVersion(settings.version);
  const loaded = await loadDependencies(packageInfo.root, settings);
  const environmentPrefix = resolveEnvironmentPrefix(
    settings.environmentPrefix,
    settings.projectName ?? packageInfo.name,
  );
  const errorFormatter = (error: unknown) => formatError(error, loaded.errorFormatter);

  return {
    f: createAdapter(
      loaded.f,
      loaded.z,
      environmentPrefix,
      version,
      settings,
      errorFormatter,
    ),
    z: loaded.z,
    environmentPrefix,
    packageRoot: packageInfo.root,
    dependencySource: loaded.source,
    formatError: errorFormatter,
  };
}

interface PackageInfo {
  name: string;
  root: string;
}

interface LoadedDependencies {
  errorFormatter?: StackFormatter;
  f: CliAdapterModule['f'];
  z: ZodNamespace;
  source: 'cache' | 'package-root' | 'project';
}

async function consumingPackage(
  settings: CreateOptionKitSettings,
): Promise<PackageInfo> {
  const root = settings.packageRoot
    ? path.resolve(settings.packageRoot)
    : await findPackageRoot(await discoveryStart(settings.moduleUrl));
  const manifest = JSON.parse(
    await readFile(path.join(root, 'package.json'), 'utf8'),
  ) as { name?: unknown };
  const name = settings.projectName ?? manifest.name;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('The consuming package must have a name or set projectName.');
  }
  return { name, root };
}

function resolvePackageVersion(
  configured: CreateOptionKitSettings['version'],
): string | undefined {
  if (configured === undefined || configured === false) return undefined;
  const version = validSemver(configured);
  if (!version) {
    throw new TypeError(`version must be valid SemVer; received ${JSON.stringify(configured)}.`);
  }
  return version;
}

async function discoveryStart(moduleUrl: string | URL | undefined): Promise<string> {
  const candidate = moduleUrl === undefined
    ? process.argv[1] ?? process.cwd()
    : moduleUrl instanceof URL || moduleUrl.startsWith('file:')
      ? fileURLToPath(moduleUrl)
      : moduleUrl;
  const absolute = path.resolve(candidate);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

async function findPackageRoot(start: string): Promise<string> {
  let current: string;
  try {
    current = (await stat(start)).isDirectory() ? start : path.dirname(start);
  } catch {
    current = path.extname(start) === '' ? start : path.dirname(start);
  }

  while (true) {
    const manifest = path.join(current, 'package.json');
    try {
      await access(manifest, constants.R_OK);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`Could not find a package.json above ${JSON.stringify(start)}.`);
      }
      current = parent;
    }
  }
}

async function loadDependencies(
  packageRoot: string,
  settings: CreateOptionKitSettings,
): Promise<LoadedDependencies> {
  const project = await importDependencies(packageRoot);
  const invocationDirectory = path.resolve(settings.invocationDirectory ?? process.cwd());
  const detected = await detectPackageManager(invocationDirectory);
  const packageManager = detected ?? 'npm';
  const installRoot = path.resolve(settings.cacheDirectory ?? packageRoot);
  const installSource = settings.cacheDirectory ? 'cache' : 'package-root';
  if (settings.cacheDirectory) await ensureCachePackage(installRoot);
  const errorFormatter = await loadErrorFormatter(
    packageRoot,
    installRoot,
    packageManager,
    settings.errorFormatter,
    settings.log,
  );
  if (project) {
    return { ...project, errorFormatter, source: 'project' };
  }

  let installation = installPromises.get(installRoot);
  if (!installation) {
    installation = installAndImport(
      installRoot,
      packageManager,
      installSource,
      settings.log,
    );
    installPromises.set(installRoot, installation);
  }
  try {
    return { ...await installation, errorFormatter };
  } catch (error) {
    installPromises.delete(installRoot);
    throw error;
  }
}

async function installAndImport(
  installRoot: string,
  packageManager: string,
  source: 'cache' | 'package-root',
  log: OptionKitLogger | undefined,
): Promise<LoadedDependencies> {
  const existing = await importDependencies(installRoot);
  if (existing) return { ...existing, source };

  log?.('Installing required CLI dependencies.', {
    installDirectory: installRoot,
    packages: REQUIRED_CLI_DEPENDENCY_SPECIFIERS,
    packageManager,
  });
  try {
    await installWithoutSaving(REQUIRED_CLI_DEPENDENCY_SPECIFIERS, installRoot, packageManager);
  } catch (error) {
    log?.('Could not install required CLI dependencies.', {
      error: formatError(error),
    });
    throw error;
  }
  const installed = await importDependencies(installRoot);
  if (!installed) {
    const unresolved = ['fireargs', 'zod'].filter(name => !resolvePackage(name, installRoot));
    throw new Error(
      `CLI dependencies were installed but ${unresolved.join(' and ') || 'their exports'} could not be resolved from ${installRoot}.`,
    );
  }
  log?.('Required CLI dependencies are ready.', { installDirectory: installRoot });
  return { ...installed, source };
}

async function importDependencies(
  root: string,
): Promise<Omit<LoadedDependencies, 'source'> | undefined> {
  const [adapter, zod] = await Promise.all([
    importPackageIfAvailable<CliAdapterModule>('fireargs', root),
    importPackageIfAvailable<typeof import('zod')>('zod', root),
  ]);
  if (!adapter || !zod) return undefined;
  const requiredBuilders = ['argument', 'command', 'option', 'program'] as const;
  if (!adapter.f || requiredBuilders.some(name => typeof adapter.f[name] !== 'function')) {
    throw new TypeError('The resolved CLI adapter does not expose its required builder functions.');
  }
  if (!zod.z || typeof zod.z.object !== 'function') {
    throw new TypeError('The resolved Zod package does not expose z.object().');
  }
  return { f: adapter.f, z: zod.z };
}

async function loadErrorFormatter(
  packageRoot: string,
  installRoot: string,
  packageManager: string,
  configured: CreateOptionKitSettings['errorFormatter'],
  log: OptionKitLogger | undefined,
): Promise<StackFormatter | undefined> {
  const formatter = resolveErrorFormatter(configured);
  if (!formatter) return undefined;
  const projectFormatter = await importErrorFormatter(formatter.name, packageRoot, log);
  if (projectFormatter) return projectFormatter;

  const cacheKey = JSON.stringify([installRoot, formatter.name, formatter.specifier]);
  let installation = formatterPromises.get(cacheKey);
  if (!installation) {
    installation = installErrorFormatter(formatter, installRoot, packageManager, log);
    formatterPromises.set(cacheKey, installation);
  }
  return installation;
}

function resolveErrorFormatter(
  configured: CreateOptionKitSettings['errorFormatter'],
): Required<ErrorFormatterPackage> | undefined {
  if (configured === false) return undefined;
  if (configured === undefined) return { ...DEFAULT_ERROR_FORMATTER };
  if (typeof configured === 'string') {
    return { name: configured, specifier: configured };
  }
  return {
    name: configured.name,
    specifier: configured.specifier ?? configured.name,
  };
}

async function installErrorFormatter(
  formatter: Required<ErrorFormatterPackage>,
  installRoot: string,
  packageManager: string,
  log: OptionKitLogger | undefined,
): Promise<StackFormatter | undefined> {
  const existing = await importErrorFormatter(formatter.name, installRoot, log);
  if (existing) return existing;

  log?.('Installing optional error formatter.', {
    installDirectory: installRoot,
    package: formatter.specifier,
    packageManager,
  });
  try {
    await installWithoutSaving(formatter.specifier, installRoot, packageManager);
    const installed = await importErrorFormatter(formatter.name, installRoot, log);
    if (installed) {
      log?.('Optional error formatter is ready.', {
        installDirectory: installRoot,
        package: formatter.name,
      });
    }
    return installed;
  } catch (error) {
    log?.('Optional error formatter is unavailable.', {
      error: formatError(error),
      package: formatter.name,
    });
    return undefined;
  }
}

async function importErrorFormatter(
  packageName: string,
  root: string,
  log: OptionKitLogger | undefined,
): Promise<StackFormatter | undefined> {
  try {
    const module = await importPackageIfAvailable<ErrorFormatterModule>(packageName, root);
    if (!module) return undefined;
    const formatter = [module.default, module.formatError, module.format]
      .find(candidate => typeof candidate === 'function');
    if (typeof formatter === 'function') return formatter as StackFormatter;
    log?.('Optional error formatter has no supported function export.', {
      package: packageName,
    });
    return undefined;
  } catch (error) {
    log?.('Optional error formatter could not be loaded.', {
      error: formatError(error),
      package: packageName,
    });
    return undefined;
  }
}

function formatError(error: unknown, formatter?: StackFormatter): string {
  const stack = error instanceof Error
    ? error.stack ?? `${error.name}: ${error.message}`
    : String(error);
  if (!formatter) return stack;
  try {
    const rendered = formatter(stack, { pretty: true });
    return typeof rendered === 'string' ? rendered : stack;
  } catch {
    return stack;
  }
}

async function ensureCachePackage(cacheRoot: string): Promise<void> {
  await mkdir(cacheRoot, { recursive: true });
  const manifest = path.join(cacheRoot, 'package.json');
  try {
    await writeFile(
      manifest,
      `${JSON.stringify({ name: 'optionkit-cli-cache', private: true, type: 'module' }, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
}

const INSTALL_STATE_FILES = [
  'package.json',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
] as const;

async function installWithoutSaving(
  packages: string | string[],
  installRoot: string,
  packageManager: string,
): Promise<void> {
  const snapshots = new Map<string, Buffer | undefined>();
  for (const name of INSTALL_STATE_FILES) {
    const filename = path.join(installRoot, name);
    snapshots.set(filename, await readFileIfPresent(filename));
  }
  try {
    await installPackage(packages, {
      additionalArgs: agent => noSaveArguments(agent),
      cwd: installRoot,
      packageManager,
      preferOffline: true,
      silent: true,
    });
  } finally {
    for (const [filename, content] of snapshots) {
      const current = await readFileIfPresent(filename);
      if (content && current?.equals(content)) continue;
      if (!content && !current) continue;
      if (content) await writeFile(filename, content);
      else await rm(filename, { force: true });
    }
  }
}

async function readFileIfPresent(filename: string): Promise<Buffer | undefined> {
  try {
    return await readFile(filename);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function noSaveArguments(agent: string): string[] {
  if (agent === 'bun') return ['--no-save'];
  if (agent === 'npm') return ['--no-save', '--package-lock=false'];
  if (agent === 'pnpm') return ['--lockfile=false'];
  if (agent === 'yarn') return ['--no-lockfile'];
  return [];
}

function createAdapter(
  adapter: CliAdapterModule['f'],
  zod: ZodNamespace,
  environmentPrefix: string | false,
  version: string | undefined,
  settings: CreateOptionKitSettings,
  errorFormatter: (error: unknown) => string,
): OptionKitAdapter {
  const environmentBindings = new WeakMap<CliRoute, readonly StructuredEnvironmentBinding[]>();
  const inputSettings = version === undefined
    ? settings
    : {
        ...settings,
        reservedShortFlags: ['v', ...(settings.reservedShortFlags ?? [])],
      };
  return {
    ...adapter,
    command(configuration: CommandConfiguration = {}) {
      const { passThroughArguments, ...fireargsConfiguration } = configuration;
      const passThrough = passThroughArguments === true ||
        (typeof passThroughArguments === 'object' && passThroughArguments !== null);
      const builder = adapter.command(passThrough
        ? {
            allowExcessArguments: true,
            allowUnknownOption: true,
            enablePositionalOptions: true,
            jsonOption: false,
            llmsOption: false,
            passThroughOptions: true,
            ...fireargsConfiguration,
          }
        : {
            jsonOption: false,
            ...fireargsConfiguration,
          });
      return {
        input<Input extends ObjectSchema>(schema: Input) {
          const commandInput = passThrough
            ? addPassThroughArgument(schema, adapter, zod, passThroughArguments)
            : schema;
          const { adapted, bindings, negations } = adaptInputSchema(
            commandInput,
            adapter,
            zod,
            environmentPrefix,
            inputSettings,
          );
          const inputBuilder = builder.input(adapted);
          return {
            output(output: ZodType) {
              const outputBuilder = inputBuilder.output(output);
              const attach = (route: CliCommand): CliCommand => {
                addBooleanNegations(route, negations);
                environmentBindings.set(route, bindings);
                wrapParseBoundary(
                  route,
                  () => bindings,
                  settings.formatErrors === false ? undefined : errorFormatter,
                  version,
                );
                return route;
              };
              return {
                handler(handler: never) {
                  return attach(outputBuilder.handler(handler));
                },
                render(render: never) {
                  const handlerBuilder = outputBuilder.render(render);
                  return {
                    handler(handler: never) {
                      return attach(handlerBuilder.handler(handler));
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    program(configuration: ProgramConfiguration = {}) {
      const builder = adapter.program(configuration);
      return {
        router(routes: Readonly<Record<string, CliRoute>>) {
          const program = builder.router(routes as never);
          wrapParseBoundary(
            program,
            (argv, options) => {
              const selected = selectedLeaf(program as unknown as RuntimeRoute, argv, options);
              return selected ? environmentBindings.get(selected) ?? [] : [];
            },
            settings.formatErrors === false ? undefined : errorFormatter,
            version,
          );
          return program;
        },
      };
    },
  } as OptionKitAdapter;
}

function addVersionOption(route: CliRoute, version: string | undefined): void {
  if (version === undefined) return;
  const runtime = route as VersionedRuntimeRoute;
  if (runtime.options?.some(option => option.long === '--version')) return;
  runtime.version(version, '-v, --version');
}

function addPassThroughArgument(
  schema: ObjectSchema,
  adapter: CliAdapterModule['f'],
  zod: ZodNamespace,
  configuration: true | PassThroughArgumentsConfiguration,
): ZodObject<ZodShape> {
  const object = objectSchema(schema);
  if ('args' in object.shape) {
    throw new TypeError('passThroughArguments reserves the input field "args".');
  }
  const description = typeof configuration === 'object'
    ? configuration.description
    : undefined;
  const args = adapter.argument().schema(
    zod.array(zod.string()).default([]).describe(
      description ?? 'Arguments passed to the executable.',
    ),
  );
  return object.safeExtend({ args }) as ZodObject<ZodShape>;
}

type RegisteredFieldConfiguration =
  | ({ kind: 'argument' } & ArgumentConfiguration)
  | ({ kind: 'option' } & OptionConfiguration);

function adaptInputSchema(
  schema: ObjectSchema,
  adapter: CliAdapterModule['f'],
  zod: ZodNamespace,
  environmentPrefix: string | false,
  settings: CreateOptionKitSettings,
): {
  readonly adapted: ZodObject<ZodShape>;
  readonly bindings: readonly StructuredEnvironmentBinding[];
  readonly negations: readonly OptionNegation[];
} {
  const object = objectSchema(schema);
  const shape = object.shape as ZodShape;
  const registered = Object.fromEntries(Object.entries(shape).flatMap(([key, field]) => {
    const configuration = registeredFieldConfiguration(field, zod);
    return configuration ? [[key, configuration]] : [];
  })) as Record<string, RegisteredFieldConfiguration | undefined>;
  const configurations = optionConfigurations(
    shape,
    environmentPrefix,
    zod,
    settings,
    registered,
  );
  const fields = Object.fromEntries(Object.entries(shape).map(([key, field]) => {
    if (registered[key]?.kind === 'argument') return [key, field];
    return [key, adapter.option(configurations[key]).schema(field)];
  })) as ZodShape;
  const bindings = Object.entries(configurations).flatMap(([key, configuration]) => {
    if (
      configuration.env === undefined ||
      configuration.parse !== undefined ||
      structuredValueKind(shape[key], zod) !== 'array'
    ) return [];
    return [{
      env: configuration.env,
      name: configuration.name ?? toCliKey(key),
      short: configuration.short,
    }];
  });
  const optionNames = new Set(Object.entries(configurations).map(([key, configuration]) => (
    configuration.name ?? toCliKey(key)
  )));
  const negations = settings.booleanNegations === false
    ? []
    : Object.entries(configurations).flatMap(([key, configuration]) => {
        const name = configuration.name ?? toCliKey(key);
        if (
          configuration.parse !== undefined ||
          name.startsWith('no-') ||
          optionNames.has(`no-${name}`) ||
          !negatableValue(shape[key], zod)
        ) return [];
        return [{ name }];
      });
  return {
    adapted: object.safeExtend(fields) as ZodObject<ZodShape>,
    bindings,
    negations,
  };
}

function addBooleanNegations(
  route: CliCommand,
  negations: readonly OptionNegation[],
): void {
  const command = route as RuntimeCliCommand;
  if (typeof command.option !== 'function') return;
  for (const negation of negations) {
    const flag = `--no-${negation.name}`;
    if (command.options?.some(option => option.long === flag)) continue;
    command.option(flag, `Negate --${negation.name}.`);
  }
}

function negatableValue(
  schema: ZodType | undefined,
  zod: ZodNamespace,
  seen = new Set<ZodType>(),
): boolean {
  if (!schema || seen.has(schema)) return false;
  seen.add(schema);
  if (schema instanceof zod.ZodBoolean) return true;
  if (schema instanceof zod.ZodLiteral) return schema.values.has(false);
  if (schema instanceof zod.ZodUnion) {
    return (schema.options as readonly ZodType[])
      .some(option => negatableValue(option, zod, seen));
  }
  if (schema instanceof zod.ZodPipe) {
    return negatableValue(schema.in as ZodType, zod, seen);
  }
  const wrapper = schema as ZodType & { unwrap?: () => ZodType };
  return typeof wrapper.unwrap === 'function'
    ? negatableValue(wrapper.unwrap(), zod, seen)
    : false;
}

function objectSchema(schema: ObjectSchema): ZodObject<ZodShape> {
  let candidate: unknown = schema;
  while (candidate && typeof candidate === 'object') {
    if ('shape' in candidate) {
      const shape = candidate.shape;
      if (shape && typeof shape === 'object') return candidate as ZodObject<ZodShape>;
    }
    if (!('unwrap' in candidate) || typeof candidate.unwrap !== 'function') break;
    candidate = candidate.unwrap();
  }
  throw new TypeError('createOptionKit requires a Zod object schema, optionally wrapped as readonly.');
}

function resolveEnvironmentPrefix(
  configured: string | false | undefined,
  projectName: string,
): string | false {
  if (configured === false) return false;
  const translated = toEnvironmentKey(configured ?? projectName);
  if (!translated) throw new TypeError('The environment prefix must contain a letter or number.');
  return `${translated}_`;
}

function toCliKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/gu, '$1-$2')
    .toLowerCase();
}

function optionConfigurations<Schema extends ObjectSchema>(
  shape: ZodShape,
  environmentPrefix: string | false,
  zod: ZodNamespace,
  settings: CreateOptionKitSettings,
  registered: Readonly<Record<string, RegisteredFieldConfiguration | undefined>> = {},
): Record<string, ResolvedOptionConfiguration> {
  const keys = Object.keys(shape).filter(key => registered[key]?.kind !== 'argument');
  const overrides = Object.fromEntries(keys.map(key => {
    const existing = registered[key];
    const existingOption = existing?.kind === 'option'
      ? Object.fromEntries(Object.entries(existing).filter(([name]) => name !== 'kind'))
      : {};
    return [key, { ...settings.fields?.[key], ...existingOption }];
  })) as Record<string, OptionConfiguration | undefined>;
  const shorts = generatedShortFlags(keys, overrides, settings);

  return Object.fromEntries(keys.map(key => {
    const override = overrides?.[key];
    const generated: ResolvedOptionConfiguration = {};
    if (environmentPrefix !== false && override?.env !== false) {
      generated.env = override?.env ?? `${environmentPrefix}${toEnvironmentKey(key)}`;
      const kind = structuredValueKind(shape[key], zod);
      if (kind === 'object' && !override?.parse) generated.parse = structuredValueParser(kind);
    }
    if (override?.short !== false && (override?.short ?? shorts[key])) {
      generated.short = typeof override?.short === 'string'
        ? normalizeShort(override.short, key)
        : shorts[key];
    }
    if (override) {
      const { env: _env, short: _short, parse, ...rest } = override;
      Object.assign(generated, rest);
      if (parse) generated.parse = parse as InternalValueParser;
    }
    return [key, generated];
  }));
}

function registeredFieldConfiguration(
  schema: ZodType,
  zod: ZodNamespace,
  seen = new Set<ZodType>(),
): RegisteredFieldConfiguration | undefined {
  if (seen.has(schema)) return undefined;
  seen.add(schema);
  const metadata = zod.globalRegistry.get(schema) as Record<string, unknown> | undefined;
  const registered = metadata?.fireargs;
  if (registered && typeof registered === 'object' && 'kind' in registered) {
    const kind = (registered as { kind?: unknown }).kind;
    if (kind === 'argument' || kind === 'option') {
      return registered as RegisteredFieldConfiguration;
    }
  }
  if (schema instanceof zod.ZodPipe) {
    return registeredFieldConfiguration(schema.in as ZodType, zod, seen);
  }
  const wrapper = schema as ZodType & { unwrap?: () => ZodType };
  return typeof wrapper.unwrap === 'function'
    ? registeredFieldConfiguration(wrapper.unwrap(), zod, seen)
    : undefined;
}

/**
 * Fireargs handles structured argv values, but an environment variable reaches
 * Commander as one string. Detect only unambiguous JSON containers so scalar
 * coercion and Fireargs' native parsing remain untouched.
 */
function structuredValueKind(
  schema: ZodType | undefined,
  zod: ZodNamespace,
  seen = new Set<ZodType>(),
): StructuredValueKind | undefined {
  if (!schema || seen.has(schema)) return undefined;
  seen.add(schema);

  if (schema instanceof zod.ZodArray || schema instanceof zod.ZodTuple) return 'array';
  if (schema instanceof zod.ZodObject || schema instanceof zod.ZodRecord) return 'object';
  if (schema instanceof zod.ZodUnion) {
    const kinds = schema.options.map(option => (
      structuredValueKind(option as ZodType, zod, new Set(seen))
    )).filter((kind): kind is StructuredValueKind => kind !== undefined);
    const unique = new Set(kinds);
    return unique.size === 1 ? kinds[0] : undefined;
  }
  if (schema instanceof zod.ZodPipe) {
    return structuredValueKind(schema.in as ZodType, zod, seen);
  }

  const wrapper = schema as ZodType & { unwrap?: () => ZodType };
  return typeof wrapper.unwrap === 'function'
    ? structuredValueKind(wrapper.unwrap(), zod, seen)
    : undefined;
}

function structuredValueParser(kind: StructuredValueKind): InternalValueParser {
  return ((value: string): unknown => decodeStructuredValue(value, kind)) as InternalValueParser;
}

function decodeStructuredValue(value: string, kind: StructuredValueKind): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // A non-JSON string may still be useful to an array schema or a union.
  }
  return kind === 'array' ? splitArrayValue(value) ?? value : value;
}

function wrapParseBoundary(
  route: CliRoute,
  bindings: (
    argv: readonly string[] | undefined,
    options: CliParseOptions | undefined,
  ) => readonly StructuredEnvironmentBinding[],
  errorFormatter: ((error: unknown) => string) | undefined,
  version: string | undefined,
): void {
  const parse = route.parseAsync.bind(route);
  route.parseAsync = async (argv, options) => {
    const runtime = route as VersionedRuntimeRoute;
    if (runtime.parent === null) addVersionOption(route, version);
    const active = bindings(argv, options);
    try {
      if (!active.length) return await parse(argv, options);

      const effectiveArgv = [...(argv ?? process.argv)];
      const userOffset = argvOffset(options);
      const userArguments = effectiveArgv.slice(userOffset);
      const insertion = effectiveArgv.indexOf('--', userOffset);
      const injected: string[] = [];
      const previous = new Map<string, string>();

      for (const binding of active) {
        const value = process.env[binding.env];
        if (value === undefined) continue;
        previous.set(binding.env, value);
        delete process.env[binding.env];
        if (hasOption(userArguments, binding)) continue;
        const decoded = decodeStructuredValue(value, 'array');
        const values = Array.isArray(decoded) ? decoded : [decoded];
        for (const item of values) injected.push(`--${binding.name}=${stringifyCliValue(item)}`);
      }

      effectiveArgv.splice(insertion === -1 ? effectiveArgv.length : insertion, 0, ...injected);
      try {
        return await parse(effectiveArgv, options);
      } finally {
        for (const [name, value] of previous) process.env[name] = value;
      }
    } catch (error) {
      if (!errorFormatter) throw error;
      const command = route as RuntimeCliCommand;
      const writer = command.configureOutput?.().writeErr ?? (value => process.stderr.write(value));
      writer(`${errorFormatter(error)}\n`);
      process.exitCode = 1;
      return undefined;
    }
  };
}

function selectedLeaf(
  program: RuntimeRoute,
  argv: readonly string[] | undefined,
  options: CliParseOptions | undefined,
): CliRoute | undefined {
  const args = (argv ?? process.argv).slice(argvOffset(options));
  let current = program;
  let offset = 0;
  while (current.commands?.length) {
    let selected: RuntimeRoute | undefined;
    let selectedAt = -1;
    for (let index = offset; index < args.length; index += 1) {
      const token = args[index];
      if (!token || token.startsWith('-')) continue;
      selected = current.commands.find(command => (
        command.name?.() === token || command.aliases?.().includes(token)
      ));
      if (selected) {
        selectedAt = index;
        break;
      }
    }
    if (!selected) return undefined;
    current = selected;
    offset = selectedAt + 1;
  }
  return current;
}

function argvOffset(options: CliParseOptions | undefined): number {
  if (options?.from === 'user') return 0;
  if (options?.from === 'electron') return 1;
  return 2;
}

function hasOption(
  args: readonly string[],
  binding: StructuredEnvironmentBinding,
): boolean {
  const long = `--${binding.name}`;
  const short = binding.short ? `-${binding.short}` : undefined;
  return args.some(argument => (
    argument === long ||
    argument.startsWith(`${long}=`) ||
    (short !== undefined && (argument === short || argument.startsWith(`${short}=`)))
  ));
}

function stringifyCliValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return String(value);
  return JSON.stringify(value);
}

/** Split comma- or whitespace-delimited shell words without interpreting operators. */
function splitArrayValue(value: string): string[] | undefined {
  const result: string[] = [];
  let token = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let started = false;

  for (const character of value) {
    if (escaped) {
      token += character;
      escaped = false;
      started = true;
    } else if (character === '\\') {
      escaped = true;
      started = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      started = true;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (character === ',' || /\s/u.test(character)) {
      if (started) result.push(token);
      token = '';
      started = false;
    } else {
      token += character;
      started = true;
    }
  }

  if (quote || escaped) return undefined;
  if (started) result.push(token);
  return result;
}

function generatedShortFlags(
  keys: readonly string[],
  overrides: Record<string, OptionConfiguration | undefined> | undefined,
  settings: CreateOptionKitSettings,
): Record<string, string | undefined> {
  if (settings.shortFlags === false) return {};
  const reserved = new Set(['h', ...(settings.reservedShortFlags ?? [])].map(value => value.toLowerCase()));
  const explicit = new Map<string, string>();

  for (const key of keys) {
    const value = overrides?.[key]?.short;
    if (typeof value !== 'string') continue;
    const normalized = normalizeShort(value, key);
    const owner = explicit.get(normalized);
    if (owner) throw new TypeError(`Short flag -${normalized} is configured for both ${owner} and ${key}.`);
    if (reserved.has(normalized)) throw new TypeError(`Short flag -${normalized} is reserved.`);
    explicit.set(normalized, key);
  }

  const candidates = new Map<string, string[]>();
  for (const key of keys) {
    if (overrides?.[key]?.short !== undefined) continue;
    const longName = overrides?.[key]?.name ?? key;
    const candidate = toEnvironmentKey(longName).charAt(0).toLowerCase();
    if (!candidate || reserved.has(candidate) || explicit.has(candidate)) continue;
    candidates.set(candidate, [...(candidates.get(candidate) ?? []), key]);
  }

  const result: Record<string, string | undefined> = {};
  for (const [candidate, owners] of candidates) {
    if (owners.length === 1) result[owners[0] as string] = candidate;
  }
  return result;
}

function normalizeShort(value: string, key: string): string {
  const normalized = value.replace(/^-+/u, '').toLowerCase();
  if (!/^[a-z0-9]$/u.test(normalized)) {
    throw new TypeError(`Short flag for ${key} must be one letter or digit.`);
  }
  return normalized;
}

function toEnvironmentKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/^@/u, '')
    .replace(/[^a-zA-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toUpperCase();
}
