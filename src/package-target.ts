import type { PythonInfo } from './probes.js';
import { activatePythonVenv } from './python-venv.js';

const TARGET_OPTIONS = new Set([
  '--active',
  '--config-file',
  '--directory',
  '--isolated',
  '--prefix',
  '--project',
  '--python',
  '--root',
  '--system',
  '--target',
  '--user',
]);

const TARGET_ENVIRONMENT_VARIABLES = new Set([
  'CONDA_PREFIX',
  'PIP_PREFIX',
  'PIP_PYTHON',
  'PIP_ROOT',
  'PIP_TARGET',
  'PIP_USER',
  'PYTHONHOME',
  'PYTHONUSERBASE',
  'UV_CONFIG_FILE',
  'UV_PROJECT',
  'UV_PROJECT_ENVIRONMENT',
  'UV_PYTHON',
  'UV_PREFIX',
  'UV_ROOT',
  'UV_SYSTEM_PYTHON',
  'UV_TARGET',
]);

export function uvCommandNeedsPython(args: readonly string[]): boolean {
  return args[0] === 'pip' || args[0] === 'run';
}

/** Pin uv pip and uv run to the environment selected by Pyfig. */
export function targetUvArguments(
  args: readonly string[],
  python: PythonInfo,
): string[] {
  if (!python.virtualEnvironment) {
    throw new Error('Targeted uv commands require a virtual environment.');
  }
  assertNoTargetOverride(args);
  if (args[0] === 'run') {
    return ['run', '--no-project', '--python', python.executable, ...args.slice(1)];
  }
  if (args[0] === 'pip' && args[1]) {
    return ['pip', args[1], '--python', python.executable, ...args.slice(2)];
  }
  return [...args];
}

export function uvCommandProcessEnvironment(
  env: NodeJS.ProcessEnv,
  python?: PythonInfo,
): NodeJS.ProcessEnv {
  const sanitized = sanitizeUvProcessEnvironment(env);
  if (!python?.virtualEnvironment) return sanitized;
  return {
    ...activatePythonVenv(
      sanitized,
      python.virtualEnvironment,
      python.executable,
    ),
    UV_PYTHON: python.executable,
  };
}

/** Remove inherited values that could redirect uv away from an explicit target. */
export function sanitizeUvProcessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  for (const key of Object.keys(sanitized)) {
    if (TARGET_ENVIRONMENT_VARIABLES.has(key.toUpperCase())) delete sanitized[key];
  }
  return sanitized;
}

function assertNoTargetOverride(args: readonly string[]): void {
  for (const argument of args.slice(1)) {
    if (argument === '--') return;
    const [name] = argument.split('=', 1);
    if (name && TARGET_OPTIONS.has(name)) {
      throw new Error(`${name} cannot override the environment selected by Pyfig.`);
    }
    if (argument === '-p' || argument.startsWith('-p=') || /^-p[^-]/u.test(argument)) {
      throw new Error('-p cannot override the environment selected by Pyfig.');
    }
  }
}
