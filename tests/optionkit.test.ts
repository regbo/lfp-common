import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { z } from 'zod';
import { createOptionKit } from '../src/index.ts';

describe('optionkit', () => {
  test('maps a readonly Zod schema to env vars and unique short flags', async () => {
    const schema = z.object({
      uv: z.string().default('>=0.10,<1').describe('uv executable or version constraint.'),
      python: z.string().optional().describe('Python request.'),
      debug: z.boolean().default(false).describe('Write diagnostics.'),
      cwd: z.string().default(() => process.cwd()).describe('Working directory.'),
      env: z.record(z.string(), z.string()).optional().describe('Environment overrides.'),
    }).readonly();
    const kit = await createOptionKit({
      moduleUrl: import.meta.url,
      projectName: 'pyfig',
    });
    const command = kit.f.command({ name: 'resolve', description: 'Resolve runtimes.' })
      .input(schema)
      .output(z.void())
      .handler(() => undefined);
    const help = command.helpInformation();

    expect(kit.environmentPrefix).toBe('PYFIG_');
    expect(kit.dependencySource).toBe('project');
    expect(help).toContain('-u, --uv <value>');
    expect(help).toContain('env: PYFIG_UV');
    expect(help).toContain('-p, --python <value>');
    expect(help).toContain('-d, --debug');
    expect(help).toContain('-c, --cwd <value>');
    expect(help).toContain('-e, --env <value>');
    expect(kit.formatError(new Error('boom'))).toContain('Error: boom');
  });

  test('omits ambiguous short flags and honors field overrides', async () => {
    const schema = z.object({
      port: z.number().default(3000),
      python: z.string().optional(),
      debug: z.boolean().default(false),
    });
    const kit = await createOptionKit({
      environmentPrefix: 'example',
      fields: {
        debug: { env: false, short: 'x' },
      },
      moduleUrl: import.meta.url,
    });
    const command = kit.f.command({ name: 'serve' })
      .input(schema)
      .output(z.void())
      .handler(() => undefined);
    const help = command.helpInformation();

    expect(help).toContain('--port <value>');
    expect(help).not.toContain('-p, --port');
    expect(help).not.toContain('-p, --python');
    expect(help).toContain('-x, --debug');
    expect(help).not.toContain('EXAMPLE_DEBUG');
  });

  test('adds negated twins for defaulted and optional booleans', async () => {
    const debugKey = 'NEGATIONS_DEBUG';
    const previousDebug = process.env[debugKey];
    process.env[debugKey] = 'true';
    try {
      const kit = await createOptionKit({
        moduleUrl: import.meta.url,
        projectName: 'negations',
      });
      let received: unknown;
      const command = kit.f.command({ name: 'run' })
        .input(kit.z.object({
          cache: kit.z.boolean().default(true),
          debug: kit.z.boolean().default(false),
          verbose: kit.z.boolean().optional(),
        }))
        .output(kit.z.void())
        .handler(input => {
          received = input;
          return undefined;
        });
      const help = command.helpInformation();

      expect(help.match(/--no-cache/gu)).toHaveLength(1);
      expect(help).toContain('--no-debug');
      expect(help).toContain('--no-verbose');
      await command.parseAsync(['--no-cache', '--no-debug', '--no-verbose'], {
        from: 'user',
      });
      expect(received).toEqual({ cache: false, debug: false, verbose: false });
    } finally {
      restoreEnvironment(debugKey, previousDebug);
    }
  });

  test('derives the consuming package root from its module URL', async () => {
    const kit = await createOptionKit({
      moduleUrl: import.meta.url,
      shortFlags: false,
    });

    expect(kit.packageRoot).toBe(path.resolve(import.meta.dir, '..'));
    expect(kit.environmentPrefix).toBe('OPTIONKIT_');
  });

  test('finds the consuming root without an explicit locator', async () => {
    const originalArgv = [...process.argv];
    try {
      process.argv[1] = path.join(import.meta.dir, 'nested', 'cli.ts');
      const argvKit = await createOptionKit({ projectName: 'argv-fallback' });
      expect(argvKit.packageRoot).toBe(path.resolve(import.meta.dir, '..'));

      process.argv.length = 1;
      const cwdKit = await createOptionKit({ projectName: 'cwd-fallback' });
      expect(cwdKit.packageRoot).toBe(process.cwd());
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv);
    }
  });

  test('decodes structured environment values with JSON and shell fallbacks', async () => {
    const tagsKey = 'STRUCTURED_TEST_TAGS';
    const labelsKey = 'STRUCTURED_TEST_LABELS';
    const countsKey = 'STRUCTURED_TEST_COUNTS';
    const settingsKey = 'STRUCTURED_TEST_SETTINGS';
    const sourceKey = 'STRUCTURED_TEST_SOURCE';
    const customKey = 'STRUCTURED_TEST_CUSTOM';
    const previousTags = process.env[tagsKey];
    const previousLabels = process.env[labelsKey];
    const previousCounts = process.env[countsKey];
    const previousSettings = process.env[settingsKey];
    const previousSource = process.env[sourceKey];
    const previousCustom = process.env[customKey];
    process.env[tagsKey] = '["alpha","beta"]';
    process.env[labelsKey] = 'alpha, "beta gamma", delta\\,epsilon';
    process.env[countsKey] = '[1,2]';
    process.env[settingsKey] = '{"PORT":"3000"}';
    process.env[sourceKey] = 'settings.json';
    process.env[customKey] = 'alpha,beta';

    try {
      const schema = z.object({
        tags: z.array(z.string()).optional(),
        labels: z.array(z.string()).optional(),
        counts: z.array(z.number()).optional(),
        settings: z.record(z.string(), z.string()).optional(),
        source: z.union([z.record(z.string(), z.string()), z.string()]).optional(),
        custom: z.array(z.string()).optional(),
      });
      const kit = await createOptionKit({
        moduleUrl: import.meta.url,
        projectName: 'structured-test',
        fields: {
          custom: { parse: value => [value.toUpperCase()] },
        },
      });
      let received: unknown;
      const command = kit.f.command({ name: 'structured' })
        .input(schema)
        .output(z.void())
        .handler(input => {
          received = input;
          return undefined;
        });

      await command.parseAsync([], { from: 'user' });

      expect(received).toEqual({
        tags: ['alpha', 'beta'],
        labels: ['alpha', 'beta gamma', 'delta,epsilon'],
        counts: [1, 2],
        settings: { PORT: '3000' },
        source: 'settings.json',
        custom: ['ALPHA,BETA'],
      });

      delete process.env[tagsKey];
      delete process.env[labelsKey];
      delete process.env[countsKey];
      await command.parseAsync(
        ['--tags', 'one', 'two', '--tags', 'three'],
        { from: 'user' },
      );
      expect(received).toHaveProperty('tags', ['one', 'two', 'three']);
    } finally {
      restoreEnvironment(tagsKey, previousTags);
      restoreEnvironment(labelsKey, previousLabels);
      restoreEnvironment(countsKey, previousCounts);
      restoreEnvironment(settingsKey, previousSettings);
      restoreEnvironment(sourceKey, previousSource);
      restoreEnvironment(customKey, previousCustom);
    }
  });

  test('adapts each subcommand input while preserving registered field metadata', async () => {
    const kit = await createOptionKit({
      moduleUrl: import.meta.url,
      projectName: 'subcommands',
    });
    const input = kit.z.object({
      target: kit.f.argument().string().describe('Target name.'),
      values: kit.f.option({ parse: value => value.split(';') })
        .schema(kit.z.array(kit.z.string()).describe('Values.')),
    });
    let received: unknown;
    const run = kit.f.command({ description: 'Run a target.' })
      .input(input)
      .output(kit.z.void())
      .handler(value => {
        received = value;
        return undefined;
      });
    let inspected: unknown;
    const inspect = kit.f.command({ description: 'Inspect configuration.' })
      .input(kit.z.object({
        verbose: kit.z.boolean().default(false),
        tags: kit.z.array(kit.z.string()).optional(),
      }))
      .output(kit.z.void())
      .handler(value => {
        inspected = value;
        return undefined;
      });
    const program = kit.f.program({ name: 'example' }).router({ run, inspect });

    await program.parseAsync(['run', 'demo', '--values', 'one;two'], { from: 'user' });

    expect(received).toEqual({ target: 'demo', values: ['one', 'two'] });
    process.env.SUBCOMMANDS_TAGS = 'alpha,"beta gamma"';
    try {
      await program.parseAsync(['inspect'], { from: 'user' });
      expect(inspected).toEqual({ verbose: false, tags: ['alpha', 'beta gamma'] });
    } finally {
      delete process.env.SUBCOMMANDS_TAGS;
    }
    expect(program.helpInformation()).toContain('run');
    expect(program.helpInformation()).toContain('inspect');
  });

  test('adds typed pass-through arguments from one command setting', async () => {
    const kit = await createOptionKit({
      moduleUrl: import.meta.url,
      projectName: 'passthrough',
    });
    let received: unknown;
    const command = kit.f.command({
      name: 'run',
      passThroughArguments: true,
    })
      .input(kit.z.object({ debug: kit.z.boolean().default(false) }))
      .output(kit.z.void())
      .handler(input => {
        const args: string[] = input.args;
        received = { ...input, args };
        return undefined;
      });

    await command.parseAsync(['--debug', '--', '--version', '-c', 'print(1)'], {
      from: 'user',
    });

    expect(received).toEqual({
      args: ['--version', '-c', 'print(1)'],
      debug: true,
    });
    expect(command.helpInformation()).toContain('[args...]');
  });
});

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
