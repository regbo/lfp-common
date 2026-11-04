import { connectModelCatalog, listModels, listModelsStream } from './client.js';

const options = {
  baseUrl: process.env.CHANX_BASE_URL ?? 'ws://127.0.0.1:7777',
};

const connection = connectModelCatalog(options);
try {
  console.log('Immediate list_models response');
  console.table(await listModels(connection));
  console.log('Delayed list_models_stream responses');
  let streamed = 0;
  for await (const model of listModelsStream(connection)) {
    streamed += 1;
    console.table([model]);
  }
  console.log(`Received ${streamed} streamed models`);
} finally {
  connection.close();
}
