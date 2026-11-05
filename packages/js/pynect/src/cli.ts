#!/usr/bin/env node

import { createOptionKit } from 'optionkit';
import { generateProject } from './codegen.js';
import { projectOptionsSchema } from './config.js';
import { PACKAGE_VERSION } from './_generated/metadata.js';

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
  const program = f.program({
    name: 'pynect',
    description: 'Generate clients for Python-owned Chanx projects.',
  }).router({ generate });

  await program.parseAsync(argv);
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
