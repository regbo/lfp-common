import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectPackageManager, installPackage } from '@antfu/install-pkg';
import type { ZodObject, ZodReadonly, ZodType } from 'zod';
import { catalog } from './_generated/catalog.js';
import { importPackageIfAvailable } from './resolve.js';

type CleanStack = typeof import('clean-stack').default;
type CliAdapterModule = typeof import('fireargs');
type ZodNamespace = typeof import('zod').z;
type ZodShape = Record<string, ZodType>;
type StructuredValueKind = 'array' | 'object';
type InternalValueParser = (value: string) => never;
type ObjectSchema = ZodObject<ZodShape> | ZodReadonly<ZodObject<ZodShape>>;
type ShapeOf<Schema> = Schema extends ZodReadonly<infer Inner>
  ? Inner extends ObjectSchema
    ? ShapeOf<Inner>
    : never
  : Schema extends ZodObject<infer Shape>
    ? Shape
    : never;
type InputOf<Field> = Field extends ZodType ? import('zod').input<Field> : unknown;

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

export interface CreateOptionKitSettings<Schema extends ObjectSchema> {
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
  fields?: Partial<{
    [Key in keyof ShapeOf<Schema>]: OptionConfiguration<InputOf<ShapeOf<Schema>[Key]>>;
  }>;
  /** Working directory used to detect the caller's package manager. */
  invocationDirectory?: string;
  /** Parent directory for optionkit's versioned dependency cache. */
  cacheDirectory?: string;
  /** Optional diagnostics sink. optionkit never writes install progress itself. */
  log?: OptionKitLogger;
}

export interface OptionKit<Schema extends ObjectSchema> {
  /** CLI builder namespace, loaded from the project or the lazy cache. */
  f: CliAdapterModule['f'];
  /** Zod from the same dependency location as the CLI adapter. */
  z: ZodNamespace;
  /** The source schema fields tagged with generated CLI option metadata. */
  options: ShapeOf<Schema>;
  /** Prefix used for generated environment variables, including its trailing underscore. */
  environmentPrefix: string | false;
  /** The consuming package root discovered for this CLI. */
  packageRoot: string;
  /** Whether CLI dependencies came from the consuming project or optionkit's cache. */
  dependencySource: 'project' | 'cache';
  /** Render an error with clean-stack when the optional dependency is available. */
  formatError: (error: unknown) => string;
}

export type OptionSchemaFactory<Schema extends ObjectSchema> = (z: ZodNamespace) => Schema;

const REQUIRED_CLI_DEPENDENCY_SPECIFIERS = [
  `fireargs@${catalog.fireargs}`,
  `zod@${catalog.zod}`,
];
const CLEAN_STACK_SPECIFIER = `clean-stack@${catalog['clean-stack']}`;
const installPromises = new Map<string, Promise<LoadedDependencies>>();
const cleanStackPromises = new Map<string, Promise<CleanStack | undefined>>();

/**
 * Load the CLI adapter on demand and map a Zod object schema to environment-aware,
 * conflict-free CLI options without duplicating the schema's field definitions.
 */
export async function createOptionKit<const Schema extends ObjectSchema>(
  schemaOrFactory: Schema | OptionSchemaFactory<Schema>,
  settings: CreateOptionKitSettings<Schema> = {},
): Promise<OptionKit<Schema>> {
  const packageInfo = await consumingPackage(settings);
  const loaded = await loadDependencies(packageInfo.root, settings);
  const schema = typeof schemaOrFactory === 'function'
    ? schemaOrFactory(loaded.z)
    : schemaOrFactory;
  const shape = objectShape(schema);
  const environmentPrefix = resolveEnvironmentPrefix(
    settings.environmentPrefix,
    settings.projectName ?? packageInfo.name,
  );
  const configurations = optionConfigurations(shape, environmentPrefix, loaded.z, settings);
  const options = Object.fromEntries(Object.entries(shape).map(([key, field]) => [
    key,
    loaded.f.option(configurations[key]).schema(field),
  ])) as unknown as ShapeOf<Schema>;

  return {
    f: loaded.f,
    z: loaded.z,
    options,
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
  source: 'project' | 'cache';
}

async function consumingPackage<Schema extends ObjectSchema>(
  settings: CreateOptionKitSettings<Schema>,
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

async function loadDependencies<Schema extends ObjectSchema>(
  packageRoot: string,
  settings: CreateOptionKitSettings<Schema>,
): Promise<LoadedDependencies> {
  const project = await importDependencies(packageRoot);
  const invocationDirectory = path.resolve(settings.invocationDirectory ?? process.cwd());
  const detected = await detectPackageManager(invocationDirectory);
  const packageManager = detected ?? 'npm';
  const managerName = packageManager.split('@')[0] ?? packageManager;
  const cacheRoot = path.join(
    settings.cacheDirectory ?? defaultCacheDirectory(),
    cacheKey(managerName),
  );
  if (project) {
    const projectCleanStack = await importCleanStack(packageRoot, settings.log);
    const cleanStack = projectCleanStack ?? await cachedCleanStack(
      cacheRoot,
      packageManager,
      settings.log,
    );
    return { ...project, cleanStack, source: 'project' };
  }

  let installation = installPromises.get(cacheRoot);
  if (!installation) {
    installation = installAndImport(cacheRoot, packageManager, settings.log);
    installPromises.set(cacheRoot, installation);
  }
  try {
    return await installation;
  } catch (error) {
    installPromises.delete(cacheRoot);
    throw error;
  }
}

async function installAndImport(
  cacheRoot: string,
  packageManager: string,
  log: OptionKitLogger | undefined,
): Promise<LoadedDependencies> {
  await ensureCachePackage(cacheRoot);
  const cleanStack = await cachedCleanStack(cacheRoot, packageManager, log);
  const cached = await importDependencies(cacheRoot);
  if (cached) return { ...cached, cleanStack, source: 'cache' };

  log?.('Installing required CLI dependencies.', {
    cacheDirectory: cacheRoot,
    packages: REQUIRED_CLI_DEPENDENCY_SPECIFIERS,
    packageManager,
  });
  try {
    await installPackage(REQUIRED_CLI_DEPENDENCY_SPECIFIERS, {
      cwd: cacheRoot,
      packageManager,
      preferOffline: true,
      silent: true,
    });
  } catch (error) {
    log?.('Could not install required CLI dependencies.', {
      error: formatError(error, cleanStack),
    });
    throw error;
  }
  const installed = await importDependencies(cacheRoot);
  if (!installed) {
    throw new Error(`CLI dependencies were installed but could not be resolved from ${cacheRoot}.`);
  }
  log?.('Required CLI dependencies are ready.', { cacheDirectory: cacheRoot });
  return { ...installed, cleanStack, source: 'cache' };
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
  cacheRoot: string,
  packageManager: string,
  log: OptionKitLogger | undefined,
): Promise<CleanStack | undefined> {
  await ensureCachePackage(cacheRoot);
  const existing = await importCleanStack(cacheRoot, log);
  if (existing) return existing;

  log?.('Installing optional stack cleaner.', {
    cacheDirectory: cacheRoot,
    package: CLEAN_STACK_SPECIFIER,
    packageManager,
  });
  try {
    await installPackage(CLEAN_STACK_SPECIFIER, {
      cwd: cacheRoot,
      packageManager,
      preferOffline: true,
      silent: true,
    });
    const installed = await importCleanStack(cacheRoot, log);
    if (installed) log?.('Optional stack cleaner is ready.', { cacheDirectory: cacheRoot });
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

function defaultCacheDirectory(): string {
  const configured = process.env.OPTIONKIT_CACHE_DIR;
  if (configured) return path.resolve(configured);
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'optionkit');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'optionkit');
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'optionkit');
}

function cacheKey(packageManager: string): string {
  const digest = createHash('sha256')
    .update(`${packageManager}\0${[...REQUIRED_CLI_DEPENDENCY_SPECIFIERS, CLEAN_STACK_SPECIFIER].join('\0')}`)
    .digest('hex')
    .slice(0, 16);
  return `${packageManager}-${digest}`;
}

function objectShape(schema: ObjectSchema): ZodShape {
  let candidate: unknown = schema;
  while (candidate && typeof candidate === 'object') {
    if ('shape' in candidate) {
      const shape = candidate.shape;
      if (shape && typeof shape === 'object') return shape as ZodShape;
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
  settings: CreateOptionKitSettings<Schema>,
): Record<string, ResolvedOptionConfiguration> {
  const keys = Object.keys(shape);
  const overrides = settings.fields as Record<string, OptionConfiguration | undefined> | undefined;
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

function generatedShortFlags<Schema extends ObjectSchema>(
  keys: readonly string[],
  overrides: Record<string, OptionConfiguration | undefined> | undefined,
  settings: CreateOptionKitSettings<Schema>,
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
