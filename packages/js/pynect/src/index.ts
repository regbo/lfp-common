/** Python-owned Chanx code generation and owned stdio transport. */

export { createPynectClient } from './client.js';
export type { PynectClient, PynectConnection } from './client.js';
export { generateProject } from './codegen.js';
export type { PynectGenerateResult } from './codegen.js';
export { projectOptionsSchema, resolveProject } from './config.js';
export type { PynectProject, ProjectOptions } from './config.js';
export { startWorker, Worker, workerOptionsSchema } from './worker.js';
export type { StartWorkerOptions } from './worker.js';
