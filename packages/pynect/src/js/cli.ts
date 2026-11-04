#!/usr/bin/env node

import { createOptionKit } from 'optionkit';
import { generateProject } from './codegen.js';
import { projectOptionsSchema } from './config.js';
import { PACKAGE_VERSION } from './_generated/metadata.js';
import { serverOptionsSchema, startIpcServer } from './server.js';

/** Run the Pynect command-line interface. */
export async function main(argv: string[] = process.argv): Promise<void> {
  const { f, z } = await createOptionKit({ version: PACKAGE_VERSION });
  const generate = f.command({
    description: 'Generate a Chanx TypeScript client from the configured Python app.',
  })
    .input(projectOptionsSchema)
    .output(z.string())
    .render(output => output)
    .handler(async options => {
      const result = await generateProject(options);
      return `Generated ${result.channels} channel(s) in ${result.outDir}`;
    });
  const serve = f.command({
    description: 'Run the configured Python app over local IPC.',
  })
    .input(serverOptionsSchema)
    .output(z.string())
    .render(output => output)
    .handler(async options => {
      const server = await startIpcServer(options);
      await server.wait();
      return '';
    });
  const program = f.program({
    name: 'pynect',
    description: 'Generate and run Python-owned Chanx projects.',
  }).router({ generate, serve });

  await program.parseAsync(argv);
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
