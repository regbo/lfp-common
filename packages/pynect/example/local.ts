import { fileURLToPath } from 'node:url';
import { ensureIpcServer } from '../src/js/index.js';
import { listModels, listModelsStream } from './client.js';

await using server = await ensureIpcServer({
  root: fileURLToPath(new URL('.', import.meta.url)),
});
console.log('Immediate list_models response');
await listModels(server.clientOptions);
console.log('Delayed list_models_stream responses');
await listModelsStream(server.clientOptions);
