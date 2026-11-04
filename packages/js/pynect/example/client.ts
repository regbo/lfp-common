import type { ClientOptions } from '@chanx-js/client';
import {
  createPynectClient,
  models,
  type Model,
  type ModelFilters,
} from './_generated/model-catalog/index.js';

export function connectModelCatalog(options: ClientOptions) {
  return createPynectClient(options).connect(models);
}

export type ModelCatalogConnection = ReturnType<typeof connectModelCatalog>;

export async function listModels(
  connection: ModelCatalogConnection,
  filters: ModelFilters = {},
): Promise<Model[]> {
  await connection.ready({ timeout: 5_000 });
  const result = await connection.request({
    action: 'list_models',
    payload: filters,
  });
  return result.payload;
}

export async function* listModelsStream(
  connection: ModelCatalogConnection,
  filters: ModelFilters = {},
): AsyncGenerator<Model> {
  await connection.ready({ timeout: 5_000 });
  const result = await connection.request({
    action: 'list_models_stream',
    payload: filters,
  });
  for await (const response of result) {
    yield response.payload;
  }
}
