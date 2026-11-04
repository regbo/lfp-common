import { createClient, type ClientOptions } from '@chanx-js/client';
import {
  listModelsStream as generatedListModelsStream,
  models,
  type Model,
  type ModelFilters,
} from './_generated/model-catalog/index.js';

export async function listModels(
  options: ClientOptions,
  filters: ModelFilters = {},
): Promise<Model[]> {
  const connection = createClient(options).connect(models);
  try {
    await connection.ready({ timeout: 5_000 });

    const result = await connection.request({
      action: 'list_models',
      payload: filters,
    });
    return result.payload;
  } finally {
    connection.terminate(1000, 'Example complete');
  }
}

export async function* listModelsStream(
  options: ClientOptions,
  filters: ModelFilters = {},
): AsyncGenerator<Model> {
  for await (const response of generatedListModelsStream(options, filters)) {
    yield response.payload;
  }
}
