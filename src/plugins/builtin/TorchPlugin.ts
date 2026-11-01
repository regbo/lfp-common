/**
 * pynect - TorchPlugin (built-in)
 * Handles PyTorch Tensor objects - delegates to NumpyBridge (tensors are NumPy-compatible).
 */

import type { PynectPlugin, PluginInitContext } from '../Plugin.interface';
import type { SerializedValue, NumPyArrayResult } from '../../types/python';
import { NumpyBridge } from '../../serialization/NumpyBridge';
import { Logger } from '../../utils/Logger';

const logger = new Logger('TorchPlugin');
const bridge = new NumpyBridge();

export type TensorResult = NumPyArrayResult & {
  requiresGrad: boolean;
  isCuda:       boolean;
  device:       string;
  gradFn:       string | null;
}

export class TorchPlugin implements PynectPlugin {
  readonly name             = 'torch';
  readonly version          = '1.0.0';
  readonly description      = 'Enhanced PyTorch Tensor support';
  readonly supportedModules = ['torch'] as const;
  readonly handledTypes     = ['Tensor'] as const;

  onInit(ctx: PluginInitContext): void {
    ctx.registerTypeHandler('Tensor', this._handle.bind(this));
    logger.debug('TorchPlugin initialised');
  }

  transformResult(raw: SerializedValue, typeHint: string, meta: Record<string, unknown>): TensorResult | null {
    return typeHint === 'Tensor' ? this._handle(raw, typeHint, meta) : null;
  }

  private _handle(raw: SerializedValue, _t?: string, meta?: Record<string, unknown>): TensorResult | null {
    try {
      const base = bridge.deserialize(raw);
      if (!base) {return null;}
      const isCuda = Boolean(meta?.['isCuda']);
      if (isCuda) {logger.warn('CUDA Tensor: data was copied to CPU for transfer.');}
      return {
        ...base,
        requiresGrad: Boolean(meta?.['requiresGrad']),
        isCuda,
        device:  String(meta?.['device'] ?? 'cpu'),
        gradFn:  meta?.['gradFn'] !== null && meta?.['gradFn'] !== undefined ? String(meta?.['gradFn']) : null,
      } as TensorResult;
    } catch (err) {
      logger.warn(`Tensor deserialization error: ${err}`);
      return null;
    }
  }
}
