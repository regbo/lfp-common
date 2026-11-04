/** Python-owned Chanx code generation and local IPC transport. */

export { createPynectClient, defineStreamActions } from './client.js';
export type {
  PynectClient,
  PynectConnection,
  PynectStreamDefinition,
} from './client.js';
export { generateProject } from './codegen.js';
export type { PynectGenerateResult } from './codegen.js';
export { projectOptionsSchema, resolveProject } from './config.js';
export type { PynectProject, ProjectOptions } from './config.js';
export {
  canConnectIpc,
  createIpcSocketFactory,
  defaultIpcPath,
  ipcClientOptions,
} from './ipc.js';
export {
  ensureIpcServer,
  IpcServer,
  serverOptionsSchema,
  startIpcServer,
} from './server.js';
export type { StartIpcServerOptions } from './server.js';
