import { listModels, listModelsStream } from './client.js';

const options = {
  baseUrl: process.env.CHANX_BASE_URL ?? 'ws://127.0.0.1:7777',
};

console.log('Immediate list_models response');
console.table(await listModels(options));
console.log('Delayed list_models_stream responses');
let streamed = 0;
for await (const model of listModelsStream(options)) {
  streamed += 1;
  console.table([model]);
}
console.log(`Received ${streamed} streamed models`);
