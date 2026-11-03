#!/usr/bin/env node

import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { installPackage } from '@antfu/install-pkg';
import { z } from 'zod';
import { createDebugLogger } from './logging.js';
import { pyfig, pyfigOptionsSchema } from './pyfig.js';

const dependencies = ['fireargs@^0.6.2'];

/** Run the Pyfig resolution command-line interface. */
export async function main(argv: string[] = process.argv): Promise<void> {
  const debug = argv.includes('--debug') ||
    ['y', 'yes', 'true', 'on', '1'].includes(process.env.DEBUG?.toLowerCase() || '');
  const log = createDebugLogger(debug);
  log('Ensuring CLI dependencies are installed.', { packages: dependencies });
  await installPackage(dependencies, {
    cwd: process.cwd(),
    silent: !debug,
    preferOffline: true,
  });
  log('CLI dependencies are ready.');

  const { f } = await import('fireargs');
  const shape = pyfigOptionsSchema.unwrap().shape;
  const output = z.object({
    uv: z.object({
      path: z.string().describe('Absolute path to the resolved uv executable.'),
      source: z.enum(['cache', 'download', 'explicit', 'path'])
        .describe('How uv was selected or obtained.'),
      version: z.string().describe('Resolved uv version.'),
    }).readonly(),
  });
  const resolve = f
    .command({
      name: 'resolve',
      description: 'Resolve uv and verify the requested Python through uv.',
    })
    .input(z.object({ ...shape }))
    .output(output)
    .render(result => [
      `uv ${result.uv.version} (${result.uv.source}): ${result.uv.path}`,
      'Python ready',
    ].join('\n'))
    .handler(async options => {
      const context = await pyfig(options);
      const child = await context.python.spawn('--version', { stdio: 'ignore' });
      const [code] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
      if (code !== 0) throw new Error(`Resolved Python exited with status ${code ?? 'unknown'}.`);
      return {
        uv: {
          path: context.uv.path,
          source: context.uv.source,
          version: context.uv.version,
        },
      };
    });

  const program = f.program({
    name: 'pyfig',
    description: 'Resolve uv and run its selected Python.',
  }).router({ resolve });

  await program.parseAsync(argv);
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(path.resolve(invokedPath)).href === import.meta.url) {
  await main();
}
