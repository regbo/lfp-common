import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deriveSchemaTypes, generateProject } from '../src/codegen.js';
import { emitStreamSupport } from '../src/codegen-stream.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('Chanx code generation', () => {
  test('upgrades the generated client export with its companion options type', async () => {
    const output = mkdtempSync(path.join(os.tmpdir(), 'pynect-codegen-client-'));
    temporaryDirectories.push(output);
    writeFileSync(
      path.join(output, 'index.ts'),
      "export { createPynectClient } from 'pynect';\n",
    );

    await emitStreamSupport(
      { operations: {} } as Parameters<typeof emitStreamSupport>[0],
      output,
    );

    expect(readFileSync(path.join(output, 'index.ts'), 'utf8')).toBe(
      "export { createPynectClient, type PynectClientOptions } from 'pynect';\n",
    );
  });

  test('derives generated TypeScript types from Zod validators', async () => {
    const output = mkdtempSync(path.join(os.tmpdir(), 'pynect-codegen-types-'));
    temporaryDirectories.push(output);
    writeFileSync(path.join(output, 'schemas.ts'), [
      'export interface Request { action: "ping"; }',
      'export type Status = "ready";',
    ].join('\n'));
    writeFileSync(path.join(output, 'schemas.zod.ts'), [
      'export const RequestSchema = z.object({ action: z.literal("ping") });',
      'export const StatusSchema = z.literal("ready");',
    ].join('\n'));

    await deriveSchemaTypes(output);

    const schemas = readFileSync(path.join(output, 'schemas.ts'), 'utf8');
    expect(schemas).toContain('export type Request = z.output<typeof RequestSchema>;');
    expect(schemas).toContain('export type Status = z.output<typeof StatusSchema>;');
    expect(schemas).not.toContain('interface Request');
  });

  test('exports Python AsyncAPI and generates TypeScript into one folder', async () => {
    const output = mkdtempSync(path.join(os.tmpdir(), 'pynect-codegen-'));
    temporaryDirectories.push(output);
    const root = path.resolve(import.meta.dir, '../../../py/pynect');

    const result = await generateProject({
      root,
      app: 'tests.fixtures.catalog:app',
      name: 'catalog-fixture',
      out: output,
    });

    expect(result.channels).toBe(1);
    expect(existsSync(path.join(output, 'asyncapi.json'))).toBe(true);
    expect(existsSync(path.join(output, 'index.ts'))).toBe(true);
    expect(existsSync(path.join(output, 'streams.ts'))).toBe(false);
    expect(readFileSync(path.join(output, 'channels.ts'), 'utf8')).toContain('catalog');
    expect(readFileSync(path.join(output, 'schemas.ts'), 'utf8')).toContain('PingRequest');
    const channels = readFileSync(path.join(output, 'channels.ts'), 'utf8');
    expect(channels).toContain("'watch'");
    expect(channels).toContain("'sync_watch'");
    const index = readFileSync(path.join(output, 'index.ts'), 'utf8');
    expect(index).toContain(
      "export { createPynectClient, type PynectClientOptions } from 'pynect';",
    );
    expect(index).not.toMatch(/\bcreateClient\b/u);
    expect(index).not.toContain("./streams.js");

    const schema = JSON.parse(readFileSync(path.join(output, 'asyncapi.json'), 'utf8'));
    expect(schema.operations.watch['x-pynect-stream']).toBe(true);
    expect(schema.operations.watch.reply.messages).toHaveLength(1);
  }, 60_000);
});
