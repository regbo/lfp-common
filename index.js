function toConfigKey(flag) {
  return flag.replace(/-([a-zA-Z0-9])/g, (_, character) => character.toUpperCase());
}

function toEnvironmentKey(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toUpperCase();
}

function parseBoolean(value, key, source) {
  const normalized = String(value).toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;

  throw new TypeError(`${source} value for ${key} must be a boolean`);
}

function coerce(value, sample, key, source) {
  if (typeof sample === "string") return String(value);
  if (typeof sample === "boolean") return parseBoolean(value, key, source);

  if (typeof sample === "number") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
    throw new TypeError(`${source} value for ${key} must be a finite number`);
  }

  throw new TypeError(`default value for ${key} must be a string, number, or boolean`);
}

function parseArguments(argv) {
  const values = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") break;
    if (!token.startsWith("--")) continue;

    const body = token.slice(2);
    if (body.startsWith("no-") && !body.includes("=")) {
      values.set(toConfigKey(body.slice(3)), false);
      continue;
    }

    const equalsAt = body.indexOf("=");
    if (equalsAt !== -1) {
      values.set(toConfigKey(body.slice(0, equalsAt)), body.slice(equalsAt + 1));
      continue;
    }

    const key = toConfigKey(body);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, true);
    }
  }

  return values;
}

/**
 * Resolves a typed configuration object. Later sources override earlier ones:
 * defaults, then environment variables, then command-line flags.
 */
export function loadConfig({
  defaults,
  env = process.env,
  argv = process.argv.slice(2),
  prefix = "",
}) {
  if (defaults === null || typeof defaults !== "object" || Array.isArray(defaults)) {
    throw new TypeError("defaults must be an object");
  }

  const resolved = { ...defaults };

  for (const [key, sample] of Object.entries(defaults)) {
    coerce(sample, sample, key, "default");
    const environmentKey = `${prefix}${toEnvironmentKey(key)}`;
    const environmentValue = env[environmentKey];

    if (environmentValue !== undefined) {
      resolved[key] = coerce(environmentValue, sample, key, "environment");
    }
  }

  for (const [key, value] of parseArguments(argv)) {
    if (!Object.hasOwn(defaults, key)) continue;

    const sample = defaults[key];
    if (value === true && typeof sample !== "boolean") {
      throw new TypeError(`CLI flag --${key} requires a value`);
    }

    resolved[key] = coerce(value, sample, key, "CLI");
  }

  return resolved;
}
