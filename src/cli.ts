#!/usr/bin/env node

import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installPackage } from '@antfu/install-pkg';
import type * as Fireargs from 'fireargs';
import { z } from 'zod';
import { createDebugLogger } from './logging.js';
import { pyfig, pyfigOptionsSchema, type PyfigOptions } from './pyfig.js';

const fireargsSpecifier = 'fireargs@^0.6.2';
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const passthroughArguments = z.array(z.string());

/** Run the Pyfig resolution command-line interface. */
export async function main(argv: string[] = process.argv): Promise<void> {
  const debug = argv.includes('--debug') ||
    ['y', 'yes', 'true', 'on', '1'].includes(process.env.DEBUG?.toLowerCase() || '');
  const log = createDebugLogger(debug);
  const { f } = await loadFireargs(log);
  const shape = pyfigOptionsSchema.unwrap().shape;
  const createInput = (passthrough = false) => z.object({
    uv: f.option({ env: 'PYFIG_UV' }).schema(shape.uv),
    python: f.option({ env: 'PYFIG_PYTHON' }).schema(shape.python),
    debug: f.option({ env: 'PYFIG_DEBUG' }).schema(shape.debug),
    cwd: f.option({ env: 'PYFIG_CWD' }).schema(shape.cwd),
    env: f.option({ env: 'PYFIG_ENV' }).schema(shape.env),
    ...(passthrough
      ? {
          args: f.argument().schema(
            z.array(z.string()).default([]).describe('Arguments passed to the executable.'),
          ),
        }
      : {}),
  });
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

  const passthroughConfig = {
    allowExcessArguments: true,
    allowUnknownOption: true,
    enablePositionalOptions: true,
    jsonOption: false as const,
    llmsOption: false as const,
    passThroughOptions: true,
  };
  const createPassthroughCommand = (
    target: 'python' | 'uv',
    description: string,
  ) => f
    .command({
      ...passthroughConfig,
      name: target,
      description,
    })
    .input(createInput(true))
    .output(z.void())
    .handler(({ args, ...options }) =>
      runExecutable(target, passthroughArguments.parse(args), options));

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

async function loadFireargs(log: ReturnType<typeof createDebugLogger>): Promise<typeof Fireargs> {
  log('Installing optional CLI dependency.', { package: fireargsSpecifier });
  await installPackage(fireargsSpecifier, {
    additionalArgs: agent => noSaveArguments(agent),
    cwd: packageRoot,
    preferOffline: true,
    silent: true,
  });
  log('Optional CLI dependency is ready.');
  return import('fireargs');
}


function noSaveArguments(agent: string): string[] {
  if (agent === 'bun') return ['--no-save'];
  if (agent === 'npm') return ['--no-save', '--package-lock=false'];
  return []
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(path.resolve(invokedPath)).href === import.meta.url) {
  await main();
}
