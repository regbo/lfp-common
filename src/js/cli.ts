#!/usr/bin/env node

import { Command, InvalidArgumentError } from 'commander';
import {
  generateBindings,
  setupDevelopment,
  type CodegenOptions,
  type SetupDevOptions,
} from './codegen';

/** Run the Pynect command-line interface. */
export async function main(argv: string[] = process.argv): Promise<void> {
  const program = new Command()
    .name('pynect')
    .description('Bridge Node.js and Bun applications to typed Python environments.')
    .showHelpAfterError();
  const codegen = program.command('codegen').description('Generate typed Python bindings.');

  codegen.command('generate')
    .description('Generate TypeScript bindings from Python modules.')
    .option('--root <path>', 'Python project root.', '.')
    .option('--config <path>', 'Standalone codegen configuration file.')
    .option('--module <module>', 'Python module or alias=module mapping.', collect)
    .option('--out <path>', 'Generated TypeScript output path.')
    .option('--class-name <name>', 'Generated project class name.')
    .option('--project <path>', 'uv project path.')
    .option('--no-project', 'Run uv without project discovery.')
    .option('--with <requirement>', 'Additional uv requirement.', collect)
    .option('--with-editable <requirement>', 'Additional editable uv requirement.', collect)
    .option('--with-requirements <path>', 'Requirements or lock file.', collect)
    .option('--uv-args <argument>', 'Additional uv run argument.', collect)
    .option('--validate-pydantic', 'Validate arguments with Pydantic.')
    .option('--no-validate-pydantic', 'Do not validate arguments with Pydantic.')
    .option('--auto-close', 'Allow the host to exit while Python is running.')
    .option('--no-auto-close', 'Keep the host alive while Python is running.')
    .option('--startup-timeout-ms <milliseconds>', 'Worker startup timeout.', integer)
    .option('--call-timeout-ms <milliseconds>', 'Default RPC timeout.', integer)
    .action(async (options: CodegenOptions) => {
      process.stdout.write(`${await generateBindings(options)}\n`);
    });

  codegen.command('setup-dev')
    .description('Configure editor integration for code generation.')
    .option('--root <path>', 'Project root.', '.')
    .option('--dry-run', 'Describe changes without writing files.', false)
    .action((options: SetupDevOptions) => {
      process.stdout.write(`${setupDevelopment(options).join('\n')}\n`);
    });

  await program.parseAsync(argv);
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function integer(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError('Expected an integer.');
  }
  return parsed;
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
