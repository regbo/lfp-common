import { startExampleWorker } from './stdio-worker.js';

const workerPromise = startExampleWorker();
const clientPromise = import('./client.js');
await using worker = await workerPromise;
const client = await clientPromise;
const connection = client.connectModelCatalog(worker.clientOptions);
try {
  console.log('Immediate list_models response');
  console.table(await client.listModels(connection));
  console.log('Delayed list_models_stream responses');
  let streamed = 0;
  for await (const model of client.listModelsStream(connection)) {
    streamed += 1;
    console.table([model]);
  }
  console.log(`Received ${streamed} streamed models`);
} finally {
  connection.close();
}
