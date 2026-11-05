import { fileURLToPath } from 'node:url';
import {
  startWorker,
  type StartWorkerOptions,
  type Worker,
} from 'pynect';

const exampleRoot = fileURLToPath(new URL('.', import.meta.url));

/** Start the HTTP-neutral demo service in an invocation-owned Python subprocess. */
export function startExampleWorker(
  options: Pick<StartWorkerOptions, 'python' | 'stdout' | 'stderr'> & {
    readonly preloadChat?: boolean;
  } = {},
): Promise<Worker> {
  const python = options.python ?? process.env.PYNECT_PYTHON;
  return startWorker({
    app: options.preloadChat
      ? 'pynect_example.chat_service:app'
      : 'pynect_example.service:app',
    root: exampleRoot,
    ...(python === undefined ? {} : { python }),
    stdout: options.stdout,
    stderr: options.stderr,
  });
}
