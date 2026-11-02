#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { ensurePython } from './provision.js';

interface CliOptions {
  dependency: string[];
  requirement: string[];
  python?: string;
  requiresPython?: string;
  requiresUv?: string;
  managedPython?: string;
  home?: string;
  projectRoot?: string;
  requireEmbedding: boolean;
  requireGil: boolean;
  check: boolean;
  json: boolean;
}

const packageVersion = (JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }).version;

const program = new Command()
  .name('pyfig')
  .description('Prepare uv and an isolated Python venv.')
  .version(packageVersion)
  .option('--dependency <specifier>', 'PEP 508 runtime dependency; repeatable', collect, [])
  .option('--requirement <path>', 'requirements file; repeatable', collect, [])
  .option('--python <path>', 'Python executable to check first')
  .option('--requires-python <specifier>', 'accepted Python PEP 440 specifier')
  .option('--managed-python <request>', 'Python version request passed to uv')
  .option('--requires-uv <specifier>', 'accepted uv PEP 440 specifier')
  .option('--home <path>', 'cache and managed-tool directory')
  .option('--project-root <path>', 'root that owns node_modules/.pyfig')
  .option('--require-embedding', 'require Python.h and a linkable CPython library', false)
  .option('--require-gil', 'reject free-threaded CPython builds', false)
  .option('--check', 'check only; do not create an environment or install Python or uv', false)
  .option('--json', 'print machine-readable JSON', false)
  .action(async (cli: CliOptions) => {
    const environment = await ensurePython({
      dependencies: cli.dependency,
      requirements: cli.requirement,
      python: cli.python,
      requiresPython: cli.requiresPython,
      managedPython: cli.managedPython,
      requiresUv: cli.requiresUv,
      cacheDir: cli.home,
      projectRoot: cli.projectRoot,
      requireEmbedding: cli.requireEmbedding,
      requireGil: cli.requireGil,
      autoInstall: cli.check ? false : undefined,
      installPython: cli.check ? false : undefined,
      installUv: cli.check ? false : undefined,
      createVirtualEnvironment: cli.check ? false : undefined,
    });

    if (cli.json) {
      console.log(JSON.stringify(environment, null, 2));
      return;
    }
    console.log(`Python ${environment.python.version}: ${environment.python.executable}`);
    console.log(`uv ${environment.uv.version}: ${environment.uv.executable}`);
    console.log(`Environment: ${environment.managed ? 'Pyfig-managed' : 'existing'}`);
    if (environment.venvId) console.log(`Venv: ${environment.venvId}`);
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`pyfig: ${message}`);
  process.exitCode = 1;
});

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
