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
  const { f, formatError, z } = await createOptionKit();
  const generateInput = codegenOptionsSchema.extend({
    noAutoClose: f.option({
      conflicts: 'autoClose',
      env: false,
      name: 'no-auto-close',
      short: false,
    }).schema(z.boolean().default(false).describe('Keep the host alive while Python is running.')),
    noProject: f.option({
      conflicts: 'project',
      env: false,
      name: 'no-project',
      short: false,
    }).schema(z.boolean().default(false).describe('Run uv without project discovery.')),
    noValidatePydantic: f.option({
      conflicts: 'validatePydantic',
      env: false,
      name: 'no-validate-pydantic',
      short: false,
    }).schema(z.boolean().default(false).describe('Do not validate arguments with Pydantic.')),
  });
  const generate = f.command({
    description: 'Generate TypeScript bindings from Python modules.',
  })
    .input(generateInput)
    .output(z.string())
    .render(output => output)
    .handler(({
      noAutoClose,
      noProject,
      noValidatePydantic,
      ...options
    }) => generateBindings({
      ...options,
      autoClose: noAutoClose ? false : options.autoClose,
      project: noProject ? false : options.project,
      validatePydantic: noValidatePydantic ? false : options.validatePydantic,
    }));

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

  try {
    await program.parseAsync(argv);
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  }
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
