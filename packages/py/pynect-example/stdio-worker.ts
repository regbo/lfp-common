import { fileURLToPath } from 'node:url';
import {
  startWorker,
  type StartWorkerOptions,
  type Worker,
} from 'pynect';

const exampleRoot = fileURLToPath(new URL('.', import.meta.url));

export type StartExampleWorkerOptions = Omit<StartWorkerOptions, 'app' | 'root'> & {
  readonly preloadChat?: boolean;
};

/** Start the HTTP-neutral demo service in an invocation-owned Python subprocess. */
export function startExampleWorker(
  options: StartExampleWorkerOptions = {},
): Promise<Worker> {
  const { preloadChat, python: configuredPython, ...workerOptions } = options;
  const python = configuredPython ?? process.env.PYNECT_PYTHON;
  return startWorker({
    ...workerOptions,
    app: preloadChat
      ? 'pynect_example.chat_service:app'
      : 'pynect_example.service:app',
    root: exampleRoot,
    ...(python === undefined ? {} : { python }),
  });
}
