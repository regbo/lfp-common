export type ConfigValue = string | number | boolean;

export interface LoadConfigOptions<T extends Record<string, ConfigValue>> {
  defaults: T;
  env?: Readonly<Record<string, string | undefined>>;
  argv?: readonly string[];
  prefix?: string;
}

function toConfigKey(flag: string): string {
  return flag.replace(/-([a-zA-Z0-9])/gu, (_, character: string) => character.toUpperCase());
}

function parseBoolean(value: unknown, key: string, source: string): boolean {
  const normalized = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new TypeError(`${source} value for ${key} must be a boolean`);
}

function coerce(value: unknown, sample: ConfigValue, key: string, source: string): ConfigValue {
  if (typeof sample === 'string') return String(value);
  if (typeof sample === 'boolean') return parseBoolean(value, key, source);

  if (typeof sample === 'number') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
    throw new TypeError(`${source} value for ${key} must be a finite number`);
  }

  throw new TypeError(`default value for ${key} must be a string, number, or boolean`);
}

function parseArguments(argv: readonly string[]): Map<string, string | boolean> {
  const values = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || token === '--') break;
    if (!token.startsWith('--')) continue;

    const body = token.slice(2);
    if (body.startsWith('no-') && !body.includes('=')) {
      values.set(toConfigKey(body.slice(3)), false);
      continue;
    }

    const equalsAt = body.indexOf('=');
    if (equalsAt !== -1) {
      values.set(toConfigKey(body.slice(0, equalsAt)), body.slice(equalsAt + 1));
      continue;
    }

    const key = toConfigKey(body);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, true);
    }
  }

  return values;
}

/** Resolve configuration in increasing precedence: defaults, environment, then CLI flags. */
export function loadConfig<T extends Record<string, ConfigValue>>({
  defaults,
  env = process.env,
  argv = process.argv.slice(2),
  prefix = '',
}: LoadConfigOptions<T>): T {
  if (defaults === null || typeof defaults !== 'object' || Array.isArray(defaults)) {
    throw new TypeError('defaults must be an object');
  }

  const resolved: Record<string, ConfigValue> = { ...defaults };

  for (const [key, sample] of Object.entries(defaults)) {
    coerce(sample, sample, key, 'default');
    const environmentValue = env[`${prefix}${toEnvironmentKey(key)}`];
    if (environmentValue !== undefined) {
      resolved[key] = coerce(environmentValue, sample, key, 'environment');
    }
  }

  for (const [key, value] of parseArguments(argv)) {
    if (!Object.hasOwn(defaults, key)) continue;
    const sample = defaults[key];
    if (sample === undefined) continue;
    if (value === true && typeof sample !== 'boolean') {
      throw new TypeError(`CLI flag --${key} requires a value`);
    }
    resolved[key] = coerce(value, sample, key, 'CLI');
  }

  return resolved as T;
}

/** Translate camel-case, kebab-case, or scoped package text to upper snake case. */
export function toEnvironmentKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/^@/u, '')
    .replace(/[^a-zA-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toUpperCase();
}
