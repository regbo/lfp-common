import { listModels, listModelsStream } from './client.js';

const options = {
  baseUrl: process.env.CHANX_BASE_URL ?? 'ws://127.0.0.1:7777',
};

console.log('Immediate list_models response');
await listModels(options);
console.log('Delayed list_models_stream responses');
await listModelsStream(options);
