import { fileURLToPath } from 'node:url';
import type { Writable } from 'node:stream';
import {
  startWorker,
  type Worker,
} from '../../js/pynect/src/index.js';

const exampleRoot = fileURLToPath(new URL('.', import.meta.url));
const defaultPython = fileURLToPath(new URL(
  process.platform === 'win32' ? '../../../.venv/Scripts/python.exe' : '../../../.venv/bin/python',
  import.meta.url,
));

/** Start a Python subprocess owned by this invocation and connected over stdio. */
export function startExampleWorker(options: {
  readonly stdout?: Writable;
  readonly stderr?: Writable;
} = {}): Promise<Worker> {
  return startWorker({
    root: exampleRoot,
    python: process.env.PYNECT_PYTHON ?? defaultPython,
    stdout: options.stdout,
    stderr: options.stderr,
  });
}
