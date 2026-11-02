import { Command, Option } from 'commander';
import { parseBoolean } from '../config/project';
import { syncProject } from '../env/project-environment';

interface SyncCommandOptions {
  projectRoot?: string;
  python?: string;
  requiresPython?: string;
  managedPython?: string;
  requiresUv?: string;
  dependency?: string[];
  requirement?: string[];
  installPython?: boolean;
  installUv?: boolean;
  createVirtualEnvironment?: boolean;
  offline?: boolean;
  json?: boolean;
}

export function createSyncCommand(): Command {
  return new Command('sync')
    .description('Prepare the application Python environment with Pyfig.')
    .option('--project-root <path>', 'application root that owns package.json')
    .option('--python <path>', 'preferred base Python executable')
    .option('--requires-python <range>', 'accepted Python version range')
    .option('--managed-python <version>', 'managed Python request used as a fallback')
    .option('--requires-uv <specifier>', 'PEP 440 uv version specifier Pyfig may install')
    .option('--dependency <specifier...>', 'additional Python dependency specifiers')
    .option('--requirement <path...>', 'requirements files resolved from the application root')
    .addOption(booleanOption('--install-python <boolean>', 'allow managed Python installation'))
    .addOption(booleanOption('--install-uv <boolean>', 'allow uv installation'))
    .addOption(booleanOption(
      '--create-virtual-environment <boolean>',
      'allow creation of a Pyfig-managed virtual environment',
    ))
    .option('--offline', 'prohibit network access during preparation')
    .option('--json', 'print the result as JSON')
    .action(async (options: SyncCommandOptions) => {
      const result = await syncProject({
        projectRoot: options.projectRoot,
        project: {
          'requires-python': options.requiresPython,
          dependencies: options.dependency,
        },
        tool: {
          pynect: {
            python: options.python,
            managedPython: options.managedPython,
            requiresUv: options.requiresUv,
            requirements: options.requirement,
            installPython: options.installPython,
            installUv: options.installUv,
            createVirtualEnvironment: options.createVirtualEnvironment,
          },
        },
        offline: options.offline,
      });
      const python = result.environment.python;
      if (options.json) {
        process.stdout.write(`${JSON.stringify({
          projectRoot: result.plan.config.projectRoot,
          environment: python.virtualEnvironment,
          python: python.executable,
          dependencies: result.plan.dependencies.length,
          requirements: result.plan.requirements,
          contributors: result.plan.contributions.map(item => ({
            name: item.packageName,
            version: item.packageVersion,
          })),
        }, null, 2)}\n`);
        return;
      }
      process.stdout.write(
        `Prepared ${result.plan.dependencies.length} Python dependency constraint(s) from ` +
        `${result.plan.contributions.length} package(s).\n` +
        `Environment: ${python.virtualEnvironment}\n` +
        `Python: ${python.executable}\n`,
      );
    });
}

function booleanOption(flags: string, description: string): Option {
  return new Option(flags, description).argParser(value => parseBoolean(value, flags));
}
