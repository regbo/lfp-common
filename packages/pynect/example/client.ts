import { createClient, type ClientOptions } from '@chanx-js/client';
import {
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
): AsyncGenerator<Model, number> {
  const connection = createClient(options).connect(models);
  try {
    await connection.ready({ timeout: 5_000 });
    const responses = connection.stream();
    try {
      connection.send({
        action: 'list_models_stream',
        payload: filters,
      });

      for await (const response of responses) {
        if (response.action === 'models_complete') {
          return response.payload;
        }
        if (response.action === 'model') {
          yield response.payload;
        }
      }
      return 0;
    } finally {
      responses.close();
    }
  } finally {
    connection.terminate(1000, 'Example complete');
  }
}
