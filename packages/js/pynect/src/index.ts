/** Python-owned Chanx code generation and owned stdio transport. */

export { createPynectClient } from './client.js';
export type { PynectClient, PynectClientOptions, PynectConnection } from './client.js';
export { generateProject } from './codegen.js';
export type { PynectGenerateResult } from './codegen.js';
export {
  projectOptionsSchema,
  pynectPyfigOptionsSchema,
  pynectPythonSchema,
  resolveProject,
} from './config.js';
export type {
  PynectProject,
  PynectPyfigOptions,
  PynectPython,
  ProjectOptions,
} from './config.js';
export { startWorker, Worker, workerOptionsSchema } from './worker.js';
export type { StartWorkerOptions } from './worker.js';
