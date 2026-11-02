#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installPackage } from '@antfu/install-pkg';
import { z } from 'zod';
import { debugLog, setDebugLogging } from './logging.js';
import { pyfig, pyfigOptionsSchema, type PyfigOptions } from './pyfig.js';

const dependencies = ['fireargs@^0.6.2']

/** Run the Pyfig command-line interface. */
export async function main(argv: string[] = process.argv): Promise<void> {
    const debug = argv.includes('--debug') || ['y', 'yes', 'true', 'on', '1'].includes(process.env.DEBUG?.toLowerCase() || '');
    setDebugLogging(debug);
    debugLog('Ensuring CLI dependencies are installed.', {
        packages: dependencies,
    });
    await installPackage(dependencies, {
        cwd: process.cwd(),
        silent: !debug,
        preferOffline: true,
    });
    debugLog('CLI dependencies are ready.');
    const { f } = await import('fireargs');
    const createInput = (passthrough = false) => {
        const shape = pyfigOptionsSchema.unwrap().shape;
        return z.object({
            ...shape,
            ...(passthrough
                ? { args: f.argument().schema(z.array(z.string()).default([]).describe('Arguments passed to the executable.')) }
                : {}),
        });
    };
    const output = z.object({
        uv: executableMetadataSchema('uv'),
        python: executableMetadataSchema('Python'),
    });
    const resolve = f
        .command({
            name: 'resolve',
            description: 'Resolve or provision compatible uv and Python executables.',
        })
        .input(createInput())
        .output(output)
        .render(result => [
            `uv ${result.uv.version}: ${result.uv.path}`,
            `Python ${result.python.version}: ${result.python.path}`,
        ].join('\n'))
        .handler(options => pyfig(options));

    const passthroughConfig = {
        allowUnknownOption: true,
        allowExcessArguments: true,
        enablePositionalOptions: true,
        passThroughOptions: true,
        jsonOption: false as const,
        llmsOption: false as const,
    };
    const uv = f
        .command({
            ...passthroughConfig,
            name: 'uv',
            description: 'Run the resolved uv executable.',
        })
        .input(createInput(true))
        .output(z.void())
        .handler(async ({ args, ...options }) => {
            const context = await pyfig(options);
            await run(context.uv.path, passthroughArguments.parse(args), options, context.python.path);
        });
    const python = f
        .command({
            ...passthroughConfig,
            name: 'python',
            description: 'Run Python through the resolved uv executable.',
        })
        .input(createInput(true))
        .output(z.void())
        .handler(async ({ args, ...options }) => {
            const context = await pyfig(options);
            await run(
                context.uv.path,
                ['run', 'python', ...passthroughArguments.parse(args)],
                options,
                context.python.path,
            );
        });
    const program = f.program({
        name: 'pyfig',
        description: 'Resolve and run compatible uv and Python executables.',
    }).router({ resolve, uv, python });

    await program.parseAsync(argv);
}

const passthroughArguments = z.array(z.string());

function executableMetadataSchema(name: string) {
    return z.object({
        path: z.string().describe(`Absolute path to the resolved ${name} executable.`),
        version: z.string().describe(`Resolved ${name} version.`),
    }).readonly();
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(path.resolve(invokedPath)).href === import.meta.url) {
    await main();
}

function run(
    executable: string,
    args: readonly string[],
    options: PyfigOptions,
    pythonPath: string,
): Promise<void> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [key, value] of Object.entries(options.env ?? {})) {
        if (value === undefined) delete env[key];
        else env[key] = value;
    }
    env['UV_PYTHON'] = pythonPath;

    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, {
            cwd: options.cwd,
            env,
            stdio: 'inherit',
            windowsHide: true,
        });
        child.once('error', reject);
        child.once('close', code => {
            if (code !== 0) process.exitCode = code ?? 1;
            resolve();
        });
    });
}