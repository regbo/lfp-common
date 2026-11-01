/**
 * pynect - PyContext
 * Manages an isolated Python execution context (namespace).
 * Useful for running code in isolation without polluting the global namespace.
 */

import type { NativeAddon } from '../types/addon';
import type { PyObjectId } from '../types/python';
import { PyProxy, PYPROXY_INTERNAL } from './PyProxy';
import { translatePythonError } from '../utils/ErrorTranslator';
import { Logger } from '../utils/Logger';

const logger = new Logger('PyContext');

/**
 * PyContext - an isolated Python execution environment.
 *
 * @example
 * ```typescript
 * const ctx = await PyContext.create(addon);
 *
 * // Run code in isolation
 * await ctx.exec('x = 42');
 * await ctx.exec('y = x * 2');
 * const result = await ctx.eval('x + y');
 * console.log(result);  // 126
 *
 * // Import into context
 * const pd = await ctx.import('pandas');
 * await ctx.exec("df = pd.DataFrame({'a': [1,2,3]})");
 * const df = await ctx.get('df');
 * ```
 */
export class PyContext {
  private readonly _addon: NativeAddon;
  private readonly _namespacePyId: PyObjectId;
  private _variables: Map<string, PyObjectId>;
  private _destroyed = false;

  private constructor(addon: NativeAddon, namespacePyId: PyObjectId) {
    this._addon = addon;
    this._namespacePyId = namespacePyId;
    this._variables = new Map();
  }

  /**
   * Create a new isolated Python context.
   */
  static async create(addon: NativeAddon): Promise<PyContext> {
    // Create a fresh namespace dict in Python
    const result = await addon.evalPython('{}') as {
      success?: boolean;
      objectId?: number;
      isObject?: boolean;
      error?: { type: string; message: string; traceback: string };
    };

    if (!result.success) {
      if (result.error) {
        throw translatePythonError({
          type: result.error.type,
          message: result.error.message,
          traceback: result.error.traceback || '',
        });
      }
      throw new Error('Failed to create Python context');
    }

    if (!result.objectId) {
      throw new Error('Context namespace object ID not returned');
    }

    return new PyContext(addon, result.objectId as PyObjectId);
  }

  /**
   * Execute Python code in this context.
   */
  async exec(code: string): Promise<void> {
    this._ensureNotDestroyed();

    const result = await this._addon.runPythonCode(code) as {
      success?: boolean;
      error?: { type: string; message: string; traceback: string };
    };

    if (!result.success && result.error) {
      throw translatePythonError({
        type: result.error.type,
        message: result.error.message,
        traceback: result.error.traceback || '',
      });
    }
  }

  /**
   * Evaluate a Python expression in this context and return the result.
   */
  async eval(expression: string): Promise<unknown> {
    this._ensureNotDestroyed();

    const result = await this._addon.evalPython(expression) as {
      success?: boolean;
      resultJson?: string;
      objectId?: number;
      isObject?: boolean;
      error?: { type: string; message: string; traceback: string };
    };

    if (!result.success) {
      if (result.error) {
        throw translatePythonError({
          type: result.error.type,
          message: result.error.message,
          traceback: result.error.traceback || '',
        });
      }
      throw new Error('Evaluation failed');
    }

    if (result.isObject && result.objectId) {
      return PyProxy._createFromObjectId(
        result.objectId as PyObjectId,
        [],
        this._addon
      );
    }

    if (result.resultJson !== undefined) {
      try {
        return JSON.parse(result.resultJson);
      } catch {
        return result.resultJson;
      }
    }

    return null;
  }

  /**
   * Import a module into this context.
   */
  async import(moduleName: string): Promise<PyProxy> {
    this._ensureNotDestroyed();

    const result = await this._addon.importModule(moduleName) as {
      success?: boolean;
      objectId?: number;
      error?: { type: string; message: string; traceback: string };
    };

    if (!result.success) {
      if (result.error) {
        throw translatePythonError({
          type: result.error.type,
          message: result.error.message,
          traceback: result.error.traceback || '',
        });
      }
      throw new Error(`Failed to import module '${moduleName}'`);
    }

    if (!result.objectId) {
      throw new Error('Module object ID not returned');
    }

    return PyProxy._createFromObjectId(
      result.objectId as PyObjectId,
      [],
      this._addon
    );
  }

  /**
   * Get a variable from the context namespace.
   */
  async get(name: string): Promise<unknown> {
    this._ensureNotDestroyed();

    const pyId = this._variables.get(name);

    if (pyId) {
      return PyProxy._createFromObjectId(pyId, [], this._addon);
    }

    // Try to get from Python global namespace
    const result = await this._addon.evalPython(name) as {
      success?: boolean;
      resultJson?: string;
      objectId?: number;
      isObject?: boolean;
      error?: { type: string; message: string; traceback: string };
    };

    if (!result.success) {
      if (result.error?.type === 'NameError') {
        return undefined;
      }
      if (result.error) {
        throw translatePythonError({
          type: result.error.type,
          message: result.error.message,
          traceback: result.error.traceback || '',
        });
      }
      return undefined;
    }

    if (result.isObject && result.objectId) {
      return PyProxy._createFromObjectId(
        result.objectId as PyObjectId,
        [],
        this._addon
      );
    }

    if (result.resultJson !== undefined) {
      try {
        return JSON.parse(result.resultJson);
      } catch {
        return result.resultJson;
      }
    }

    return undefined;
  }

  /**
   * Set a variable in the context namespace.
   */
  async set(name: string, value: unknown): Promise<void> {
    this._ensureNotDestroyed();
    assertPythonIdentifier(name);

    if (value instanceof PyProxy) {
      const internal = value[PYPROXY_INTERNAL];
      this._variables.set(name, internal.objectId);
      return;
    }

    // For primitives and serializable values: set via exec
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError(`Value for '${name}' is not JSON serializable`);
    }
    const encoded = Buffer.from(serialized, 'utf8').toString('base64');
    await this.exec(
      `${name} = __import__('json').loads(__import__('base64').b64decode('${encoded}'))`,
    );
  }

  /**
   * Check if a name is defined in the context.
   */
  async has(name: string): Promise<boolean> {
    this._ensureNotDestroyed();
    try {
      const val = await this.get(name);
      return val !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Delete a variable from the context.
   */
  async delete(name: string): Promise<void> {
    this._ensureNotDestroyed();
    assertPythonIdentifier(name);
    this._variables.delete(name);
    await this.exec(`del ${name}`).catch(() => {}); // ignore if not defined
  }

  /**
   * Clear all variables in the context.
   */
  async clear(): Promise<void> {
    this._ensureNotDestroyed();
    this._variables.clear();
  }

  /**
   * Destroy the context and free resources.
   */
  async destroy(): Promise<void> {
    if (this._destroyed) {return;}
    this._destroyed = true;
    this._variables.clear();
    this._addon.decRef(this._namespacePyId as number);
    logger.debug('PyContext destroyed');
  }

  private _ensureNotDestroyed(): void {
    if (this._destroyed) {
      throw new Error('PyContext has been destroyed');
    }
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.destroy();
  }
}

function assertPythonIdentifier(name: string): void {
  if (!/^[A-Za-z_]\w*$/u.test(name)) {
    throw new TypeError(`Invalid Python identifier: ${JSON.stringify(name)}`);
  }
}
