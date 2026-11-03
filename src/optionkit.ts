import { constants } from 'node:fs';
import { access, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectPackageManager, installPackage } from '@antfu/install-pkg';
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

type CleanStack = typeof import('clean-stack').default;
type CliAdapterModule = typeof import('fireargs');
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

export type CommandConfiguration = Record<string, unknown>;
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

interface HandlerBuilder<Input extends ObjectSchema, Output extends ZodType> {
  handler(
    handler: (
      input: SchemaOutput<Input>,
      context: CommandContext,
    ) => SchemaInput<Output> | Promise<SchemaInput<Output>>,
  ): CliCommand;
}

interface OutputBuilder<Input extends ObjectSchema, Output extends ZodType>
  extends HandlerBuilder<Input, Output> {
  render(
    render: (
      output: SchemaOutput<Output>,
      context: RenderContext<SchemaOutput<Input>>,
    ) => string | void | Promise<string | void>,
  ): HandlerBuilder<Input, Output>;
}

export interface OptionKitAdapter {
  argument<Value = never>(configuration?: ArgumentConfiguration<Value>): FieldBuilder<Value>;
  command(configuration?: CommandConfiguration): {
    input<Input extends ObjectSchema>(schema: Input): {
      output<Output extends ZodType>(schema: Output): OutputBuilder<Input, Output>;
    };
  };
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

export type OptionKitLogger = (
  message: string,
  details?: Readonly<Record<string, unknown>>,
) => void;

export interface CreateOptionKitSettings {
  /** Module URL for the consuming CLI; used to find its nearest package.json. */
  moduleUrl?: string | URL;
  /** Explicit consuming package root when moduleUrl discovery is not appropriate. */
  packageRoot?: string;
  /** Override the consuming package name used to derive the environment prefix. */
  projectName?: string;
  /** Override the generated prefix, or disable environment bindings. */
  environmentPrefix?: string | false;
  /** Generate non-conflicting single-letter flags. Defaults to true. */
  shortFlags?: boolean;
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
  /** Render an error with clean-stack when the optional dependency is available. */
  formatError: (error: unknown) => string;
}

const REQUIRED_CLI_DEPENDENCY_SPECIFIERS = [
  `fireargs@${catalog.fireargs}`,
  `zod@${catalog.zod}`,
];
const CLEAN_STACK_SPECIFIER = `clean-stack@${catalog['clean-stack']}`;
const installPromises = new Map<string, Promise<LoadedDependencies>>();
const cleanStackPromises = new Map<string, Promise<CleanStack | undefined>>();

/**
 * Load the CLI adapter on demand. Every command input is transparently augmented
 * with environment bindings and conflict-free short flags.
 */
export async function createOptionKit(
  settings: CreateOptionKitSettings = {},
): Promise<OptionKit> {
  const packageInfo = await consumingPackage(settings);
  const loaded = await loadDependencies(packageInfo.root, settings);
  const environmentPrefix = resolveEnvironmentPrefix(
    settings.environmentPrefix,
    settings.projectName ?? packageInfo.name,
  );

  return {
    f: createAdapter(loaded.f, loaded.z, environmentPrefix, settings),
    z: loaded.z,
    environmentPrefix,
    packageRoot: packageInfo.root,
    dependencySource: loaded.source,
    formatError: error => formatError(error, loaded.cleanStack),
  };
}

interface PackageInfo {
  name: string;
  root: string;
}

interface LoadedDependencies {
  cleanStack?: CleanStack;
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
  if (project) {
    const projectCleanStack = await importCleanStack(packageRoot, settings.log);
    const cleanStack = projectCleanStack ?? await cachedCleanStack(
      installRoot,
      packageManager,
      settings.log,
    );
    return { ...project, cleanStack, source: 'project' };
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
    return await installation;
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
  const cleanStack = await cachedCleanStack(installRoot, packageManager, log);
  const existing = await importDependencies(installRoot);
  if (existing) return { ...existing, cleanStack, source };

  log?.('Installing required CLI dependencies.', {
    installDirectory: installRoot,
    packages: REQUIRED_CLI_DEPENDENCY_SPECIFIERS,
    packageManager,
  });
  try {
    await installWithoutSaving(REQUIRED_CLI_DEPENDENCY_SPECIFIERS, installRoot, packageManager);
  } catch (error) {
    log?.('Could not install required CLI dependencies.', {
      error: formatError(error, cleanStack),
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
  return { ...installed, cleanStack, source };
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

async function cachedCleanStack(
  cacheRoot: string,
  packageManager: string,
  log: OptionKitLogger | undefined,
): Promise<CleanStack | undefined> {
  let installation = cleanStackPromises.get(cacheRoot);
  if (!installation) {
    installation = installCleanStack(cacheRoot, packageManager, log);
    cleanStackPromises.set(cacheRoot, installation);
  }
  return installation;
}

async function installCleanStack(
  installRoot: string,
  packageManager: string,
  log: OptionKitLogger | undefined,
): Promise<CleanStack | undefined> {
  const existing = await importCleanStack(installRoot, log);
  if (existing) return existing;

  log?.('Installing optional stack cleaner.', {
    installDirectory: installRoot,
    package: CLEAN_STACK_SPECIFIER,
    packageManager,
  });
  try {
    await installWithoutSaving(CLEAN_STACK_SPECIFIER, installRoot, packageManager);
    const installed = await importCleanStack(installRoot, log);
    if (installed) log?.('Optional stack cleaner is ready.', { installDirectory: installRoot });
    return installed;
  } catch (error) {
    log?.('Optional stack cleaner is unavailable.', { error: formatError(error) });
    return undefined;
  }
}

async function importCleanStack(
  root: string,
  log: OptionKitLogger | undefined,
): Promise<CleanStack | undefined> {
  try {
    return (await importPackageIfAvailable<typeof import('clean-stack')>('clean-stack', root))
      ?.default;
  } catch (error) {
    log?.('Optional stack cleaner could not be loaded.', { error: formatError(error) });
    return undefined;
  }
}

function formatError(error: unknown, cleanStack?: CleanStack): string {
  const stack = error instanceof Error
    ? error.stack ?? `${error.name}: ${error.message}`
    : String(error);
  if (!cleanStack) return stack;
  try {
    return cleanStack(stack, { pretty: true });
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
    try {
      snapshots.set(filename, await readFile(filename));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      snapshots.set(filename, undefined);
    }
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
      if (content) await writeFile(filename, content);
      else await rm(filename, { force: true });
    }
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
  settings: CreateOptionKitSettings,
): OptionKitAdapter {
  return {
    ...adapter,
    command(configuration: CommandConfiguration = {}) {
      const builder = adapter.command(configuration);
      return {
        input<Input extends ObjectSchema>(schema: Input) {
          const adapted = adaptInputSchema(
            schema,
            adapter,
            zod,
            environmentPrefix,
            settings,
          );
          return builder.input(adapted) as never;
        },
      };
    },
  } as OptionKitAdapter;
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
): ZodObject<ZodShape> {
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
  return object.safeExtend(fields) as ZodObject<ZodShape>;
}

function objectShape(schema: ObjectSchema): ZodShape {
  return objectSchema(schema).shape as ZodShape;
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
      if (kind && !override?.parse) generated.parse = structuredValueParser(kind);
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
  return ((value: string): unknown => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      // A non-JSON string may still be useful to an array schema or a union.
    }
    return kind === 'array' ? splitArrayValue(value) ?? value : value;
  }) as InternalValueParser;
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
