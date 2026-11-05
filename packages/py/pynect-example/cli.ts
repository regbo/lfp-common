#!/usr/bin/env bun

import { createOptionKit } from 'optionkit';
import type { ModelCatalogConnection } from './client.js';
import { startExampleWorker } from './stdio-worker.js';

type ModelCatalogClient = typeof import('./client.js');

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
  const modelSchema = z.object({
    id: z.string(),
    provider: z.enum(['anthropic', 'openai']),
    context_window: z.number().int().positive(),
  }).readonly();
  const modelsSchema = z.array(modelSchema);
  const list = f.command({
    description: 'Return all matching models in one response.',
    jsonOption: {},
  })
    .input(filtersSchema)
    .output(modelsSchema)
    .render(models => { console.table(models); })
    .handler((filters, context) => withIpcWorker(
      context.json,
      (client, connection) => client.listModels(connection, filters),
    ));
  let suppressBufferedStreamOutput = false;
  const stream = f.command({
    description: 'Print matching models as the delayed stream yields them.',
    jsonOption: {},
    configureOutput: {
      writeOut: (value: string) => {
        if (!suppressBufferedStreamOutput) process.stdout.write(value);
      },
    },
  })
    .input(filtersSchema)
    .output(modelsSchema)
    .render(models => {
      const suffix = models.length === 1 ? '' : 's';
      return `Received ${models.length} streamed model${suffix}`;
    })
    .handler((filters, context) => {
      // Fireargs normally serializes JSON after the handler; the stream already
      // writes validated NDJSON incrementally, so suppress only that final copy.
      suppressBufferedStreamOutput = context.json;
      return withIpcWorker(context.json, async (client, connection) => {
        const streamed = [];
        for await (const model of client.listModelsStream(connection, filters)) {
          streamed.push(model);
          if (context.json) process.stdout.write(`${JSON.stringify(model)}\n`);
          else console.table([model]);
        }
        return streamed;
      });
    });
  const program = f.program({
    name: 'pynect-model-catalog',
    description: 'Call the Pynect model catalog through owned stdio IPC.',
  }).router({
    'list-models': list,
    'list-models-stream': stream,
  });

  await program.parseAsync(argv);
}

async function withIpcWorker<Result>(
  json: boolean,
  run: (client: ModelCatalogClient, connection: ModelCatalogConnection) => Promise<Result>,
): Promise<Result> {
  const workerPromise = startExampleWorker({
    stdout: json ? process.stderr : process.stdout,
  });
  const clientPromise = import('./client.js');
  await using worker = await workerPromise;
  const client = await clientPromise;
  const connection = client.connectModelCatalog(worker.clientOptions);
  try {
    return await run(client, connection);
  } finally {
    connection.close();
  }
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
