/**
 * pynect - Plugin Interface
 *
 * Every pynect plugin must implement this interface. Plugins can:
 * - Transform Python object values as they cross the JS boundary
 * - Register custom type mappings
 * - Hook into lifecycle events (init, shutdown)
 * - Add convenience methods to PyProxy instances
 */

import type { SerializedValue } from '../types/python';

// Public types

export type PythonTypeName = string;

export interface PluginInitContext {
  runtimeVersion: string;
  pythonVersion: { major: number; minor: number; patch: number };
  registerTypeHandler(typeName: PythonTypeName, handler: TypeTransformHandler): void;
}

export type TypeTransformHandler = (
  raw:      SerializedValue,
  typeHint: string,
  metadata: Record<string, unknown>
) => unknown | null;

export interface PynectPlugin {
  readonly name:             string;
  readonly version:          string;
  readonly supportedModules: readonly string[];
  readonly handledTypes?:    readonly PythonTypeName[];
  readonly description?:     string;
  readonly homepage?:        string;

  onInit?(ctx: PluginInitContext):                      Promise<void> | void;
  onShutdown?():                                        Promise<void> | void;
  onModuleImported?(moduleName: string, moduleOid: number): Promise<void> | void;

  transformResult?: TypeTransformHandler;
  serializeValue?(value: unknown, targetTypeName?: string): SerializedValue | null;
}

export interface PluginRegistration {
  plugin:       PynectPlugin;
  active:       boolean;
  loadedAt:     number;
  modulesBound: Set<string>;
}
