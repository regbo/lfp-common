/**
 * pynect - PandasPlugin (built-in)
 * Intercepts DataFrame/Series wire objects and routes through DataFrameBridge.
 */

import type { PynectPlugin, PluginInitContext } from '../plugin.interface';
import type { SerializedValue, DataFrameResult, SeriesResult } from '../../types/python';
import { DataFrameBridge } from '../../serialization/data-frame-bridge';
import { Logger } from '../../utils/logger';

const logger = new Logger('PandasPlugin');
const bridge = new DataFrameBridge();

export class PandasPlugin implements PynectPlugin {
  readonly name             = 'pandas';
  readonly version          = '1.0.0';
  readonly description      = 'Enhanced pandas DataFrame and Series support';
  readonly supportedModules = ['pandas', 'pd'] as const;
  readonly handledTypes     = ['DataFrame', 'Series', 'DataFrameGroupBy', 'SeriesGroupBy'] as const;

  onInit(ctx: PluginInitContext): void {
    ctx.registerTypeHandler('DataFrame',        this._handleDF.bind(this));
    ctx.registerTypeHandler('DataFrameGroupBy', this._handleDF.bind(this));
    ctx.registerTypeHandler('Series',           this._handleSeries.bind(this));
    ctx.registerTypeHandler('SeriesGroupBy',    this._handleSeries.bind(this));
    logger.debug('PandasPlugin initialised');
  }

  onModuleImported(moduleName: string): void {
    logger.debug(`pandas module imported: ${moduleName}`);
  }

  transformResult(raw: SerializedValue, typeHint: string): DataFrameResult | SeriesResult | null {
    if (typeHint === 'DataFrame' || typeHint === 'DataFrameGroupBy') {return this._handleDF(raw, typeHint, {});}
    if (typeHint === 'Series'   || typeHint === 'SeriesGroupBy')    {return this._handleSeries(raw, typeHint, {});}
    return null;
  }

  private _handleDF(raw: SerializedValue, _typeHint?: string, _meta?: Record<string, unknown>): DataFrameResult | null {
    try { return bridge.deserializeDataFrame(raw); }
    catch (err) { logger.warn(`DataFrame deserialization error: ${err}`); return null; }
  }

  private _handleSeries(raw: SerializedValue, _typeHint?: string, _meta?: Record<string, unknown>): SeriesResult | null {
    try { return bridge.deserializeSeries(raw); }
    catch (err) { logger.warn(`Series deserialization error: ${err}`); return null; }
  }
}
