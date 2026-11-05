import { fileURLToPath } from 'node:url';
import type { Writable } from 'node:stream';
import {
  startIpcServer,
  type IpcServer,
} from '../src/index.js';

const exampleRoot = fileURLToPath(new URL('.', import.meta.url));

/** Start an invocation-scoped Python server owned by the current process. */
export function startExampleIpcServer(options: {
  readonly stdout?: Writable;
} = {}): Promise<IpcServer> {
  return startIpcServer({
    root: exampleRoot,
    stdout: options.stdout,
  });
}
