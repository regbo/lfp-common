/**
 * pynect - PyModule
 * Represents a Python module with its full namespace.
 * Inherits from PyProxy but adds module-specific introspection.
 */

import { PyProxy, PYPROXY_INTERNAL } from './PyProxy';
import type { NativeAddon } from '../types/addon';
import type { PyObjectId, PyModuleInspection } from '../types/python';
import { Logger } from '../utils/Logger';

const logger = new Logger('PyModule');

/**
 * PyModule extends PyProxy with module-specific utilities.
 *
 * @example
 * ```typescript
 * const pd = await py.import('pandas');
 * // pd is a PyModule
 * const df = await pd.read_csv('data.csv');  // access module attribute
 * const info = await pd.__pynect_inspect__();  // get module metadata
 * ```
 */
export class PyModule extends PyProxy {
  private readonly _moduleName: string;
  private _inspection: PyModuleInspection | null = null;

  constructor(
    objectId: PyObjectId,
    moduleName: string,
    addon: NativeAddon,
    callTimeout?: number,
    executionTimeout?: number,
  ) {
    super({
      objectId,
      path: [],
      addon,
      isResolved: false,
      callTimeout,
      executionTimeout,
      childCache: new Map(),
    });
    this._moduleName = moduleName;
  }

  /** The Python module name */
  get moduleName(): string {
    return this._moduleName;
  }

  /** Object ID in Python heap */
  get objectId(): PyObjectId {
    return this[PYPROXY_INTERNAL].objectId;
  }

  /**
   * Inspect the module - returns detailed type information.
   * Cached after first call.
   */
  async inspect(): Promise<PyModuleInspection> {
    if (this._inspection) {return this._inspection;}

    const addon = this[PYPROXY_INTERNAL].addon;

    try {
      // Run Python introspection
      const result = await addon.runPythonCode(`
import json
import sys

def _inspect_module_${this._moduleName.replace(/\./g, '_')}():
    try:
        import ${this._moduleName} as _mod
        import inspect

        result = {
            'name': '${this._moduleName}',
            'file': getattr(_mod, '__file__', None),
            'docstring': (getattr(_mod, '__doc__', '') or '')[:500],
            'version': getattr(_mod, '__version__', None),
            'functions': [],
            'classes': [],
            'constants': [],
            'submodules': [],
        }

        for name in dir(_mod):
            if name.startswith('_'):
                continue
            try:
                obj = getattr(_mod, name)
                if inspect.ismodule(obj):
                    result['submodules'].append(name)
                elif inspect.isclass(obj):
                    result['classes'].append({'name': name, 'type': 'class'})
                elif callable(obj):
                    result['functions'].append({'name': name, 'type': 'function'})
                else:
                    result['constants'].append({'name': name, 'type': type(obj).__name__})
            except Exception:
                pass

        return result
    except Exception as e:
        return {'name': '${this._moduleName}', 'error': str(e), 'functions': [], 'classes': [], 'constants': [], 'submodules': []}

_result = _inspect_module_${this._moduleName.replace(/\./g, '_')}()
json.dumps(_result)
`);

      const r = result as { success?: boolean; resultJson?: string };
      if (r.success && r.resultJson) {
        const parsed = JSON.parse(r.resultJson.replace(/^"|"$/g, '').replace(/\\"/g, '"'));
        this._inspection = parsed as PyModuleInspection;
        return this._inspection;
      }
    } catch (err) {
      logger.warn(`Failed to inspect module ${this._moduleName}`, err);
    }

    // Return minimal inspection
    this._inspection = {
      name: this._moduleName,
      docstring: '',
      functions: [],
      classes: [],
      constants: [],
      submodules: [],
    };

    return this._inspection;
  }

  /**
   * Get list of public names in the module (dir() equivalent).
   */
  async getNames(): Promise<string[]> {
    const addon = this[PYPROXY_INTERNAL].addon;
    const result = await addon.getObjectKeys(this.objectId as number);
    const r = result as { success?: boolean; resultJson?: string };
    if (r.success && r.resultJson) {
      try {
        return JSON.parse(r.resultJson) as string[];
      } catch {
        return [];
      }
    }
    return [];
  }

  /**
   * Check if the module has a specific attribute.
   */
  async has(name: string): Promise<boolean> {
    const addon = this[PYPROXY_INTERNAL].addon;
    return addon.hasAttribute(this.objectId as number, name);
  }

  /**
   * Get module version string.
   */
  async getVersion(): Promise<string | null> {
    const inspection = await this.inspect();
    return inspection.version ?? null;
  }

  /**
   * Reload the module (re-imports from Python).
   */
  async reload(): Promise<void> {
    const addon = this[PYPROXY_INTERNAL].addon;
    await addon.reloadModule(this.objectId as number);
    this._inspection = null;  // Clear inspection cache
    this[PYPROXY_INTERNAL].childCache.clear();  // Clear attribute cache
    logger.debug(`Module ${this._moduleName} reloaded`);
  }

  /**
   * Create a PyModule from an existing addon import result.
   */
  static fromRef(
    objectId: PyObjectId,
    moduleName: string,
    addon: NativeAddon,
    callTimeout?: number,
    executionTimeout?: number,
  ): PyModule {
    return new PyModule(objectId, moduleName, addon, callTimeout, executionTimeout);
  }

  override toString(): string {
    return `[PyModule '${this._moduleName}' id=${this.objectId}]`;
  }
}
