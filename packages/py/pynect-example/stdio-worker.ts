import { fileURLToPath } from 'node:url';
import type { Writable } from 'node:stream';
import {
  startWorker,
  type Worker,
} from 'pynect';

const exampleRoot = fileURLToPath(new URL('.', import.meta.url));
const defaultPython = fileURLToPath(new URL(
  process.platform === 'win32' ? '../../../.venv/Scripts/python.exe' : '../../../.venv/bin/python',
  import.meta.url,
));

/** Start the invocation-owned Python subprocess behind the example's stdio IPC. */
export function startExampleWorker(options: {
  readonly stdout?: Writable;
  readonly stderr?: Writable;
} = {}): Promise<Worker> {
  return startWorker({
    app: 'pynect_example.service:app',
    root: exampleRoot,
    python: process.env.PYNECT_PYTHON ?? defaultPython,
    stdout: options.stdout,
    stderr: options.stderr,
  });
}
