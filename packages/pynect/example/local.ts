import { listModels, listModelsStream } from './client.js';
import { startExampleIpcServer } from './ipc-server.js';

await using server = await startExampleIpcServer();
console.log('Immediate list_models response');
console.table(await listModels(server.clientOptions));
console.log('Delayed list_models_stream responses');
let streamed = 0;
for await (const model of listModelsStream(server.clientOptions)) {
  streamed += 1;
  console.table([model]);
}
console.log(`Received ${streamed} streamed models`);
