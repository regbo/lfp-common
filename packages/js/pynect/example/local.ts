import { connectModelCatalog, listModels, listModelsStream } from './client.js';
import { startExampleIpcServer } from './ipc-server.js';

await using server = await startExampleIpcServer();
const connection = connectModelCatalog(server.clientOptions);
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
