#!/usr/bin/env bun

import { fileURLToPath } from 'node:url';
import { createOptionKit } from 'optionkit';
import { ensureIpcServer } from '../src/js/index.js';
import { listModels, listModelsStream } from './client.js';

export async function main(argv: string[] = process.argv): Promise<void> {
  const { f, z } = await createOptionKit({
    moduleUrl: import.meta.url,
    projectName: 'pynect-model-catalog',
  });
  const filtersSchema = z.object({
    query: z.string().trim().min(1).optional()
      .describe('Case-insensitive text matched against model IDs.'),
    provider: z.enum(['anthropic', 'openai']).optional()
      .describe('Only return models from this provider.'),
  }).readonly();
  const list = f.command({
    description: 'Return all matching models in one response.',
  })
    .input(filtersSchema)
    .output(z.void())
    .handler(filters => withIpcServer(options => listModels(options, filters)));
  const stream = f.command({
    description: 'Print matching models as the delayed stream yields them.',
  })
    .input(filtersSchema)
    .output(z.void())
    .handler(filters => withIpcServer(options => listModelsStream(options, filters)));
  const program = f.program({
    name: 'pynect-model-catalog',
    description: 'Call the Pynect model catalog example over local IPC.',
  }).router({
    'list-models': list,
    'list-models-stream': stream,
  });

  await program.parseAsync(argv);
}

async function withIpcServer(
  run: (options: Awaited<ReturnType<typeof ensureIpcServer>>['clientOptions']) => Promise<void>,
): Promise<void> {
  await using server = await ensureIpcServer({
    root: fileURLToPath(new URL('.', import.meta.url)),
  });
  await run(server.clientOptions);
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
