/**
 * pynect - PluginManager
 *
 * Manages registration, lifecycle, and dispatch of pynect plugins.
 * The embedded runtime holds one PluginManager instance for its bridge.
 */

import { Logger } from '../utils/logger';
import type {
  PynectPlugin,
  PluginRegistration,
  PluginInitContext,
  TypeTransformHandler,
  PythonTypeName,
} from './plugin.interface';
import type { SerializedValue } from '../types/python';

const logger = new Logger('PluginManager');

export class PluginManager {
  private readonly _plugins   = new Map<string, PluginRegistration>();
  private readonly _typeMap   = new Map<PythonTypeName, TypeTransformHandler[]>();
  private readonly _moduleMap = new Map<string, PynectPlugin[]>();

  // Registration

  register(plugin: PynectPlugin): this {
    if (this._plugins.has(plugin.name)) {
      logger.debug(`Plugin already registered: ${plugin.name}; skipping`);
      return this;
    }

    const entry: PluginRegistration = {
      plugin,
      active:       false,
      loadedAt:     Date.now(),
      modulesBound: new Set(),
    };

    this._plugins.set(plugin.name, entry);

    for (const typeName of plugin.handledTypes ?? []) {
      const handlers = this._typeMap.get(typeName) ?? [];
      if (plugin.transformResult) {handlers.push(plugin.transformResult.bind(plugin));}
      this._typeMap.set(typeName, handlers);
    }

    for (const mod of plugin.supportedModules) {
      const list = this._moduleMap.get(mod) ?? [];
      list.push(plugin);
      this._moduleMap.set(mod, list);
    }

    logger.debug(`Registered plugin: ${plugin.name} v${plugin.version}`);
    return this;
  }

  async registerBuiltins(): Promise<void> {
    const [{ PandasPlugin }, { NumpyPlugin }, { TorchPlugin }] = await Promise.all([
      import('./builtin/pandas-plugin'),
      import('./builtin/numpy-plugin'),
      import('./builtin/torch-plugin'),
    ]);
    this.register(new PandasPlugin());
    this.register(new NumpyPlugin());
    this.register(new TorchPlugin());
  }

  // Lifecycle

  async initAll(ctx: PluginInitContext): Promise<void> {
    const extCtx: PluginInitContext = {
      ...ctx,
      registerTypeHandler: (typeName, handler) => {
        const handlers = this._typeMap.get(typeName) ?? [];
        handlers.push(handler);
        this._typeMap.set(typeName, handlers);
      },
    };

    for (const [name, entry] of this._plugins) {
      try {
        await entry.plugin.onInit?.(extCtx);
        entry.active = true;
        logger.debug(`Initialised plugin: ${name}`);
      } catch (err) {
        logger.warn(`Plugin ${name} init failed (non-fatal): ${err}`);
      }
    }
  }

  async shutdownAll(): Promise<void> {
    for (const [name, entry] of this._plugins) {
      if (!entry.active) {continue;}
      try {
        await entry.plugin.onShutdown?.();
        entry.active = false;
      } catch (err) {
        logger.warn(`Plugin ${name} shutdown error (non-fatal): ${err}`);
      }
    }
  }

  async onModuleImported(moduleName: string, moduleOid: number): Promise<void> {
    const plugins = this._moduleMap.get(moduleName) ?? [];
    for (const plugin of plugins) {
      try {
        await plugin.onModuleImported?.(moduleName, moduleOid);
      } catch (err) {
        logger.warn(`Plugin ${plugin.name} onModuleImported error: ${err}`);
      }
    }
  }

  // Transform chain

  transformResult(
    value:    SerializedValue,
    typeName: string,
    metadata: Record<string, unknown> = {}
  ): unknown | null {
    const handlers = this._typeMap.get(typeName) ?? [];
    for (const handler of handlers) {
      try {
        const result = handler(value, typeName, metadata);
        if (result !== null) {return result;}
      } catch (err) {
        logger.warn(`Type transform error for ${typeName}: ${err}`);
      }
    }
    return null;
  }

  serializeValue(value: unknown, targetTypeName?: string): SerializedValue | null {
    for (const [, entry] of this._plugins) {
      if (!entry.active || !entry.plugin.serializeValue) {continue;}
      try {
        const result = entry.plugin.serializeValue(value, targetTypeName);
        if (result !== null) {return result;}
      } catch (err) {
        logger.warn(`Plugin serialize error: ${err}`);
      }
    }
    return null;
  }

  // Introspection

  get names(): string[] { return [...this._plugins.keys()]; }
  getPlugin(name: string): PluginRegistration | undefined { return this._plugins.get(name); }
  get active(): PluginRegistration[] { return [...this._plugins.values()].filter((e) => e.active); }
  get all(): PluginRegistration[] { return [...this._plugins.values()]; }
  isActive(name: string): boolean { return this._plugins.get(name)?.active === true; }
}
