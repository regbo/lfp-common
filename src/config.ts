import path from 'node:path';
import { resolveProjectRoot, type PyfigOptions } from 'pyfig';

const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_CALL_TIMEOUT_MS = 0;

export interface CreateVenvOptions extends Omit<
  PyfigOptions,
  'dependencies' | 'requirements' | 'projectRoot' | 'requireEmbedding' | 'requireGil'
> {
  /** Working directory used by uv and added to Python's import path. */
  cwd?: string;
  /** A uv project directory, false for --no-project, or omitted for uv discovery. */
  project?: string | false;
  /** Additional requirements layered with uv run --with. */
  with?: readonly string[];
  /** Additional editable requirements layered with uv run --with-editable. */
  withEditable?: readonly string[];
  /** Requirements, pylock, or inline-metadata files passed to --with-requirements. */
  withRequirements?: readonly string[];
  /** Additional uv run options inserted before the Python command. */
  uvArgs?: readonly string[];
  /** Validate annotated arguments through Pydantic when Pydantic is available. */
  validatePydantic?: boolean;
  /** Let the host exit naturally and terminate the Python child during shutdown. */
  autoClose?: boolean;
  /** Time allowed for uv to prepare the environment and connect the worker. */
  startupTimeoutMs?: number;
  /** Default RPC timeout. Zero disables call timeouts. */
  callTimeoutMs?: number;
}

export interface ResolvedVenvOptions {
  readonly autoClose: boolean;
  readonly callTimeoutMs: number;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly project: string | false | undefined;
  readonly pyfig: PyfigOptions;
  readonly startupTimeoutMs: number;
  readonly uvArgs: readonly string[];
  readonly validatePydantic: boolean;
  readonly with: readonly string[];
  readonly withEditable: readonly string[];
  readonly withRequirements: readonly string[];
}

export function resolveVenvOptions(options: CreateVenvOptions = {}): ResolvedVenvOptions {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const project = typeof options.project === 'string'
    ? path.resolve(cwd, options.project)
    : options.project;
  const env = { ...process.env, ...options.env };

  assertPositiveTimeout('startupTimeoutMs', options.startupTimeoutMs, false);
  assertPositiveTimeout('callTimeoutMs', options.callTimeoutMs, true);
  assertUvArgs(options.uvArgs ?? []);

  const {
    autoClose: _autoClose,
    callTimeoutMs: _callTimeoutMs,
    cwd: _cwd,
    project: _project,
    startupTimeoutMs: _startupTimeoutMs,
    uvArgs: _uvArgs,
    validatePydantic: _validatePydantic,
    with: _with,
    withEditable: _withEditable,
    withRequirements: _withRequirements,
    ...pyfigOptions
  } = options;

  return Object.freeze({
    autoClose: options.autoClose ?? true,
    callTimeoutMs: options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    cwd,
    env,
    project,
    pyfig: {
      ...pyfigOptions,
      env,
      projectRoot: typeof project === 'string' ? project : resolveProjectRoot(cwd),
      requireEmbedding: false,
      requireGil: false,
    },
    startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    uvArgs: Object.freeze([...(options.uvArgs ?? [])]),
    validatePydantic: options.validatePydantic ?? true,
    with: Object.freeze([...(options.with ?? [])]),
    withEditable: Object.freeze([...(options.withEditable ?? [])]),
    withRequirements: Object.freeze(
      (options.withRequirements ?? []).map(requirement => path.resolve(cwd, requirement)),
    ),
  });
}

function assertPositiveTimeout(
  name: string,
  value: number | undefined,
  allowZero: boolean,
): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(`${name} must be ${allowZero ? 'zero or ' : ''}a positive integer.`);
  }
}

function assertUvArgs(args: readonly string[]): void {
  if (args.includes('--')) {
    throw new TypeError('uvArgs cannot contain -- or replace the worker command.');
  }
  for (const argument of args) {
    if (argument.includes('\0')) throw new TypeError('uvArgs cannot contain NUL characters.');
  }
}
