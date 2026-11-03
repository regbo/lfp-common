#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createOptionKit } from 'optionkit';
import { createDebugLogger } from './logging.js';
import { pyfig, pyfigOptionsSchema, type PyfigOptions } from './pyfig.js';

/** Run the Pyfig resolution command-line interface. */
export async function main(argv: string[] = process.argv): Promise<void> {
  const debug = argv.includes('--debug') ||
    ['y', 'yes', 'true', 'on', '1'].includes(process.env.DEBUG?.toLowerCase() || '');
  const log = createDebugLogger(debug);
  const { f, z } = await createOptionKit({
    log,
    moduleUrl: import.meta.url,
    version: 'auto',
  });
  const createInput = () => pyfigOptionsSchema.unwrap();
  const output = z.object({
    uv: z.object({
      path: z.string().describe('Absolute path to the resolved uv executable.'),
      source: z.enum(['cache', 'download', 'explicit', 'path'])
        .describe('How uv was selected or obtained.'),
      version: z.string().describe('Resolved uv version.'),
    }).readonly(),
    python: z.object({
      path: z.string().describe('Absolute path to the resolved Python executable.'),
      resolved: z.boolean().describe('Whether Python resolved successfully.'),
      version: z.string().describe('Resolved Python version.'),
    }).readonly(),
  });
  const resolve = f
    .command({
      name: 'resolve',
      description: 'Resolve uv and the requested Python through uv.',
    })
    .input(createInput())
    .output(output)
    .render(result => [
      `uv ${result.uv.version} (${result.uv.source}): ${result.uv.path}`,
      `Python ${result.python.version}: ${result.python.path}`,
    ].join('\n'))
    .handler(async options => {
      const context = await pyfig(options);
      await context.python.resolve();
      const pythonPath = context.python.path;
      const pythonVersion = context.python.version;
      if (!context.python.resolved || !pythonPath || !pythonVersion) {
        throw new Error('Python metadata was unavailable after successful resolution.');
      }
      return {
        uv: {
          path: context.uv.path,
          source: context.uv.source,
          version: context.uv.version,
        },
        python: {
          path: pythonPath,
          resolved: context.python.resolved,
          version: pythonVersion,
        },
      };
    });

  const createPassthroughCommand = (
    target: 'python' | 'uv',
    description: string,
  ) => f
    .command({
      name: target,
      description,
      passThroughArguments: true,
    })
    .input(createInput())
    .output(z.void())
    .handler(({ args, ...options }) =>
      runExecutable(target, args, options));

  const uv = createPassthroughCommand('uv', 'Run the resolved uv executable.');
  const python = createPassthroughCommand(
    'python',
    'Run Python through the resolved uv executable.',
  );

  const program = f.program({
    name: 'pyfig',
    description: 'Resolve and run uv and its selected Python.',
  }).router({ resolve, uv, python });

  await program.parseAsync(argv);
}

async function runExecutable(
  target: 'python' | 'uv',
  args: string[],
  options: PyfigOptions,
): Promise<void> {
  const context = await pyfig(options);
  const child = await context[target].spawn(...args);
  await once(child, 'close');
  if (child.exitCode !== 0) process.exitCode = child.exitCode ?? 1;
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(realpathSync(invokedPath)).href === import.meta.url) {
  await main();
}
