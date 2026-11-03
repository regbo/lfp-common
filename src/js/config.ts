import path from 'node:path';
import { pyfigOptionsSchema } from 'pyfig';
import { z } from 'zod';

const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_CALL_TIMEOUT_MS = 0;

const pyfigShape = pyfigOptionsSchema.unwrap().omit({
  cwd: true,
  env: true,
}).shape;

export const createVenvOptionsSchema = z.object({
  ...pyfigShape,
  cwd: z.string()
    .describe("Working directory used by uv and added to Python's import path.")
    .optional(),
  env: z.record(z.string(), z.string().optional())
    .describe('Environment overrides used for resolution and the Python worker.')
    .optional(),
  project: z.union([z.string(), z.literal(false)])
    .describe('A uv project directory, false for --no-project, or omitted for uv discovery.')
    .optional(),
  with: z.array(z.string())
    .describe('Additional requirements layered with uv run --with.')
    .optional(),
  withEditable: z.array(z.string())
    .describe('Additional editable requirements layered with uv run --with-editable.')
    .optional(),
  withRequirements: z.array(z.string())
    .describe('Requirements, pylock, or inline-metadata files passed to --with-requirements.')
    .optional(),
  modules: z.record(z.string(), z.string())
    .describe('Public import aliases mapped to their Python module names.')
    .optional(),
  uvArgs: z.array(z.string())
    .describe('Additional uv run options inserted before the Python command.')
    .optional(),
  validatePydantic: z.boolean()
    .describe('Validate annotated arguments through Pydantic when Pydantic is available.')
    .optional(),
  autoClose: z.boolean()
    .describe('Let the host exit naturally and terminate the Python child during shutdown.')
    .optional(),
  startupTimeoutMs: z.number().int().positive()
    .describe('Time allowed for uv to prepare the environment and connect the worker.')
    .optional(),
  callTimeoutMs: z.number().int().nonnegative()
    .describe('Default RPC timeout. Zero disables call timeouts.')
    .optional(),
}).readonly().describe('Options for a lazy uv-backed Python environment.');

export type CreateVenvOptions = z.input<typeof createVenvOptionsSchema>;

export interface ResolvedVenvOptions {
  readonly autoClose: boolean;
  readonly callTimeoutMs: number;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly modules: Readonly<Record<string, string>>;
  readonly project: string | false | undefined;
  readonly pyfig: z.input<typeof pyfigOptionsSchema>;
  readonly startupTimeoutMs: number;
  readonly uvArgs: readonly string[];
  readonly validatePydantic: boolean;
  readonly with: readonly string[];
  readonly withEditable: readonly string[];
  readonly withRequirements: readonly string[];
}

export function resolveVenvOptions(options: CreateVenvOptions = {}): ResolvedVenvOptions {
  const parsedOptions = createVenvOptionsSchema.parse(options);
  const cwd = path.resolve(parsedOptions.cwd ?? process.cwd());
  const project = typeof parsedOptions.project === 'string'
    ? path.resolve(cwd, parsedOptions.project)
    : parsedOptions.project;
  const env = { ...process.env, ...parsedOptions.env };

  assertUvArgs(parsedOptions.uvArgs ?? []);

  const {
    autoClose: _autoClose,
    callTimeoutMs: _callTimeoutMs,
    cwd: _cwd,
    modules: _modules,
    project: _project,
    startupTimeoutMs: _startupTimeoutMs,
    uvArgs: _uvArgs,
    validatePydantic: _validatePydantic,
    with: _with,
    withEditable: _withEditable,
    withRequirements: _withRequirements,
    ...pyfigOptions
  } = parsedOptions;

  return Object.freeze({
    autoClose: parsedOptions.autoClose ?? true,
    callTimeoutMs: parsedOptions.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    cwd,
    env,
    modules: Object.freeze({ ...(parsedOptions.modules ?? {}) }),
    project,
    pyfig: {
      ...pyfigOptions,
      cwd: typeof project === 'string' ? project : cwd,
      env,
    },
    startupTimeoutMs: parsedOptions.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    uvArgs: Object.freeze([...(parsedOptions.uvArgs ?? [])]),
    validatePydantic: parsedOptions.validatePydantic ?? true,
    with: Object.freeze([...(parsedOptions.with ?? [])]),
    withEditable: Object.freeze([...(parsedOptions.withEditable ?? [])]),
    withRequirements: Object.freeze(
      (parsedOptions.withRequirements ?? []).map(requirement => path.resolve(cwd, requirement)),
    ),
  });
}

function assertUvArgs(args: readonly string[]): void {
  if (args.includes('--')) {
    throw new TypeError('uvArgs cannot contain -- or replace the worker command.');
  }
  for (const argument of args) {
    if (argument.includes('\0')) throw new TypeError('uvArgs cannot contain NUL characters.');
  }
}
