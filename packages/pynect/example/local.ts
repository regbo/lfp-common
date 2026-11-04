import { fileURLToPath } from 'node:url';
import { ensureIpcServer } from '../src/js/index.js';
import { listModels } from './client.js';

await using server = await ensureIpcServer({
  root: fileURLToPath(new URL('.', import.meta.url)),
});
await listModels(server.clientOptions);
