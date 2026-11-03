import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { z } from 'zod';
import { createOptionKit, FIREARGS_VERSION } from '../src/index.ts';

describe('createOptionKit', () => {
  test('maps a readonly Zod schema to env vars and unique short flags', async () => {
    const schema = z.object({
      uv: z.string().default('>=0.10,<1').describe('uv executable or version constraint.'),
      python: z.string().optional().describe('Python request.'),
      debug: z.boolean().default(false).describe('Write diagnostics.'),
      cwd: z.string().default(() => process.cwd()).describe('Working directory.'),
      env: z.record(z.string(), z.string()).optional().describe('Environment overrides.'),
    }).readonly();
    const kit = await createOptionKit(schema, {
      moduleUrl: import.meta.url,
      projectName: 'pyfig',
    });
    const command = kit.f.command({ name: 'resolve', description: 'Resolve runtimes.' })
      .input(z.object(kit.options))
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
    const kit = await createOptionKit(schema, {
      environmentPrefix: 'example',
      fields: {
        debug: { env: false, short: 'x' },
      },
      moduleUrl: import.meta.url,
    });
    const command = kit.f.command({ name: 'serve' })
      .input(z.object(kit.options))
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
    const kit = await createOptionKit(z.object({ value: z.string() }), {
      moduleUrl: import.meta.url,
      shortFlags: false,
    });

    expect(kit.packageRoot).toBe(path.resolve(import.meta.dir, '..'));
    expect(kit.environmentPrefix).toBe('OPTIONKIT_');
  });

  test('exports the generated Fireargs range', () => {
    expect(FIREARGS_VERSION).toBe('^0.6.2');
  });
});
