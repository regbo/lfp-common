import { createClient, type ClientOptions } from '@chanx-js/client';
import { models } from './_generated/model-catalog/index.js';

export async function listModels(options: ClientOptions): Promise<void> {
  const connection = createClient(options).connect(models);
  const responses = connection.stream();
  try {
    await connection.ready({ timeout: 5_000 });
    connection.send({
      action: 'list_models',
      payload: {},
    });

    for await (const response of responses) {
      if (response.action === 'models_complete') {
        console.log(`Received ${response.payload} models`);
        break;
      }
      console.table([response.payload]);
    }
  } finally {
    responses.close();
    connection.terminate(1000, 'Example complete');
  }
}
