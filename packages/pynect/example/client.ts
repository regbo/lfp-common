import { createClient, type ClientOptions } from '@chanx-js/client';
import { models } from './_generated/model-catalog/index.js';

export async function listModels(options: ClientOptions): Promise<void> {
  const connection = createClient(options).connect(models);
  try {
    await connection.ready({ timeout: 5_000 });
    const response = await connection.request({
      action: 'list_models',
      payload: { query: 'mini' },
    });
    console.table(response.payload);
  } finally {
    connection.terminate(1000, 'Example complete');
  }
}
