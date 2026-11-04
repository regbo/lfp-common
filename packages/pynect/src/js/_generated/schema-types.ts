// Generated from pynect_worker.models. Do not edit directly.

/**
 * Interface on which the proxy-facing server listens.
 */
export type Host = string;
/**
 * Maximum MessagePack payload size for one RPC frame.
 */
export type MaxFrameBytes = number;
/**
 * Absolute WebSocket URL path accepted by the server.
 */
export type Path = string;
/**
 * Listening port; zero asks the operating system to choose one.
 */
export type Port = number;
/**
 * Validate annotated Python arguments with Pydantic.
 */
export type ValidatePydantic = boolean;
/**
 * Validate annotated Python arguments with Pydantic.
 */
export type ValidatePydantic1 = boolean;

export interface PynectSchemas {
  serverOptions: ServerOptions;
  workerOptions: WorkerOptions;
}
/**
 * Loopback-first WebSocket server configuration.
 */
export interface ServerOptions {
  host?: Host;
  maxFrameBytes?: MaxFrameBytes;
  modules?: Modules;
  path?: Path;
  port?: Port;
  validatePydantic?: ValidatePydantic;
}
/**
 * Public module names mapped to importable Python module names.
 */
export interface Modules {
  [k: string]: string;
}
/**
 * Behavior shared by local IPC workers and remote sessions.
 */
export interface WorkerOptions {
  validatePydantic?: ValidatePydantic1;
}
