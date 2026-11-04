import { listModels } from './client.js';

await listModels({
  baseUrl: process.env.CHANX_BASE_URL ?? 'ws://127.0.0.1:7777',
});
