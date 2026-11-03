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

  test('derives the consuming package root from its module URL', async () => {
    const kit = await createOptionKit({
      moduleUrl: import.meta.url,
      shortFlags: false,
    });

    expect(kit.packageRoot).toBe(path.resolve(import.meta.dir, '..'));
    expect(kit.environmentPrefix).toBe('OPTIONKIT_');
  });

  test('decodes structured environment values with JSON and shell fallbacks', async () => {
    const tagsKey = 'STRUCTURED_TEST_TAGS';
    const labelsKey = 'STRUCTURED_TEST_LABELS';
    const settingsKey = 'STRUCTURED_TEST_SETTINGS';
    const sourceKey = 'STRUCTURED_TEST_SOURCE';
    const customKey = 'STRUCTURED_TEST_CUSTOM';
    const previousTags = process.env[tagsKey];
    const previousLabels = process.env[labelsKey];
    const previousSettings = process.env[settingsKey];
    const previousSource = process.env[sourceKey];
    const previousCustom = process.env[customKey];
    process.env[tagsKey] = '["alpha","beta"]';
    process.env[labelsKey] = 'alpha, "beta gamma", delta\\,epsilon';
    process.env[settingsKey] = '{"PORT":"3000"}';
    process.env[sourceKey] = 'settings.json';
    process.env[customKey] = 'alpha,beta';

    try {
      const schema = z.object({
        tags: z.array(z.string()).optional(),
        labels: z.array(z.string()).optional(),
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
        settings: { PORT: '3000' },
        source: 'settings.json',
        custom: ['ALPHA,BETA'],
      });
    } finally {
      restoreEnvironment(tagsKey, previousTags);
      restoreEnvironment(labelsKey, previousLabels);
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
    const inspect = kit.f.command({ description: 'Inspect configuration.' })
      .input(kit.z.object({ verbose: kit.z.boolean().default(false) }))
      .output(kit.z.void())
      .handler(() => undefined);
    const program = kit.f.program({ name: 'example' }).router({ run, inspect });

    await program.parseAsync(['run', 'demo', '--values', 'one;two'], { from: 'user' });

    expect(received).toEqual({ target: 'demo', values: ['one', 'two'] });
    expect(program.helpInformation()).toContain('run');
    expect(program.helpInformation()).toContain('inspect');
  });
});

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
