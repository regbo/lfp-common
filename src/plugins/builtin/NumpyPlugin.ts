/**
 * pynect - NumpyPlugin (built-in)
 * Routes ndarray wire objects through NumpyBridge.
 */

import type { PynectPlugin, PluginInitContext } from '../Plugin.interface';
import type { SerializedValue, NumPyArrayResult } from '../../types/python';
import { NumpyBridge } from '../../serialization/NumpyBridge';
import { Logger } from '../../utils/Logger';

const logger = new Logger('NumpyPlugin');
const bridge = new NumpyBridge();

export class NumpyPlugin implements PynectPlugin {
  readonly name             = 'numpy';
  readonly version          = '1.0.0';
  readonly description      = 'Enhanced NumPy ndarray -> TypedArray mapping';
  readonly supportedModules = ['numpy', 'np'] as const;
  readonly handledTypes     = ['ndarray', 'matrix', 'MaskedArray'] as const;

  onInit(ctx: PluginInitContext): void {
    for (const t of this.handledTypes) {ctx.registerTypeHandler(t, this._handle.bind(this));}
    logger.debug('NumpyPlugin initialised');
  }

  transformResult(raw: SerializedValue, typeHint: string): NumPyArrayResult | null {
    if ((this.handledTypes as readonly string[]).includes(typeHint)) {return this._handle(raw, typeHint, {});}
    return null;
  }

  private _handle(raw: SerializedValue, _type?: string, _meta?: Record<string, unknown>): NumPyArrayResult | null {
    try { return bridge.deserialize(raw); }
    catch (err) { logger.warn(`ndarray deserialization error: ${err}`); return null; }
  }
}
