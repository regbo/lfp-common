import type { PythonContext } from 'pyfig';

/** Resolve the lazy Pyfig interpreter and return its verified absolute path. */
export async function resolvePythonPath(context: PythonContext): Promise<string> {
  await context.python.resolve();
  const pythonPath = context.python.path;
  if (!pythonPath) throw new Error('Pyfig resolved Python without exposing its executable path.');
  return pythonPath;
}
