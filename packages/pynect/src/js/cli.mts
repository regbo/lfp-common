#!/usr/bin/env node

import { createOptionKit } from 'optionkit';
import {
  codegenOptionsSchema,
  generateBindings,
  setupDevelopment,
  setupDevOptionsSchema,
} from './codegen.js';

/** Run the Pynect command-line interface. */
export async function main(argv: string[] = process.argv): Promise<void> {
  const { f, z } = await createOptionKit();
  const generate = f.command({
    description: 'Generate TypeScript bindings from Python modules.',
  })
    .input(codegenOptionsSchema)
    .output(z.string())
    .render(output => output)
    .handler(options => generateBindings(options));

  const setupDev = f.command({
    description: 'Configure editor integration for code generation.',
  })
    .input(setupDevOptionsSchema)
    .output(z.array(z.string()))
    .render(output => output.join('\n'))
    .handler(options => [...setupDevelopment(options)]);

  const codegen = f.program({
    description: 'Generate typed Python bindings.',
  }).router({ generate, 'setup-dev': setupDev });
  const program = f.program({
    name: 'pynect',
    description: 'Bridge Node.js and Bun applications to typed Python environments.',
  }).router({ codegen });

  await program.parseAsync(argv);
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
