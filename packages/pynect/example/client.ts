import { createClient, type ClientOptions } from '@chanx-js/client';
import { models } from './_generated/model-catalog/index.js';

export async function listModels(options: ClientOptions): Promise<void> {
  const connection = createClient(options).connect(models);
  try {
    await connection.ready({ timeout: 5_000 });

    const result = await connection.request({
      action: 'list_models',
      payload: {},
    });
    console.log('Immediate list_models response');
    console.table(result.payload);

    const responses = connection.stream();
    try {
      console.log('Delayed list_models_stream responses');
      connection.send({
        action: 'list_models_stream',
        payload: {},
      });

      for await (const response of responses) {
        if (response.action === 'models_complete') {
          console.log(`Received ${response.payload} streamed models`);
          break;
        }
        if (response.action === 'model') {
          console.table([response.payload]);
        }
      }
    } finally {
      responses.close();
    }
  } finally {
    connection.terminate(1000, 'Example complete');
  }
}
