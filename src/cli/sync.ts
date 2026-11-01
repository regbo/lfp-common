import { Command, Option } from 'commander';
import { parseBoolean } from '../config/project';
import { syncProject } from '../env/project-environment';

interface SyncCommandOptions {
  projectRoot?: string;
  python?: string;
  requiresPython?: string;
  managedPython?: string;
  uvVersion?: string;
  installPython?: boolean;
  installUv?: boolean;
  createVirtualEnvironment?: boolean;
  lockfile?: string;
  generatedDirectory?: string;
  frozen?: boolean;
  offline?: boolean;
  json?: boolean;
}

export function createSyncCommand(): Command {
  return new Command('sync')
    .description('Resolve and synchronize the application Python environment.')
    .option('--project-root <path>', 'application root that owns package.json')
    .option('--python <path>', 'preferred base Python executable')
    .option('--requires-python <range>', 'accepted Python version range')
    .option('--managed-python <version>', 'managed Python request used as a fallback')
    .option('--uv-version <specifier>', 'PEP 440 uv version specifier Pyfig may install')
    .addOption(booleanOption('--install-python <boolean>', 'allow managed Python installation'))
    .addOption(booleanOption('--install-uv <boolean>', 'allow uv installation'))
    .addOption(booleanOption(
      '--create-virtual-environment <boolean>',
      'allow creation of the Pyfig-managed virtual environment',
    ))
    .option('--lockfile <path>', 'project-relative lockfile path')
    .option('--generated-directory <path>', 'directory for generated pyproject.toml and uv.lock')
    .option('--frozen', 'use the existing lockfile and reject manifest changes')
    .option('--offline', 'prohibit network access during resolution and sync')
    .option('--json', 'print the result as JSON')
    .action(async (options: SyncCommandOptions) => {
      const result = await syncProject(options);
      if (options.json) {
        process.stdout.write(`${JSON.stringify({
          projectRoot: result.plan.config.projectRoot,
          lockfile: result.lockfile,
          environment: result.state.virtualEnvironment,
          generatedProject: result.plan.generatedDirectory,
          manifestHash: result.state.manifestHash,
          requirements: result.plan.requirements.length,
          contributors: result.state.contributors,
        }, null, 2)}\n`);
        return;
      }
      process.stdout.write(
        `Synchronized ${result.plan.requirements.length} Python requirement(s) from ` +
        `${result.state.contributors.length} package(s).\n` +
        `Lockfile: ${result.lockfile}\n` +
        `Generated project: ${result.plan.generatedDirectory}\n` +
        `Environment: ${result.state.virtualEnvironment}\n`,
      );
    });
}

function booleanOption(flags: string, description: string): Option {
  return new Option(flags, description).argParser(value => parseBoolean(value, flags));
}
