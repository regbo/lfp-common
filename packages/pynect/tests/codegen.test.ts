import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateProject } from '../src/js/codegen.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('Chanx code generation', () => {
  test('exports Python AsyncAPI and generates TypeScript into one folder', async () => {
    const output = mkdtempSync(path.join(os.tmpdir(), 'pynect-codegen-'));
    temporaryDirectories.push(output);
    const root = path.resolve(import.meta.dir, '..');

    const result = await generateProject({
      root,
      app: 'tests.fixtures.catalog:app',
      name: 'catalog-fixture',
      out: output,
    });

    expect(result.channels).toBe(1);
    expect(existsSync(path.join(output, 'asyncapi.json'))).toBe(true);
    expect(existsSync(path.join(output, 'index.ts'))).toBe(true);
    expect(existsSync(path.join(output, 'streams.ts'))).toBe(true);
    expect(readFileSync(path.join(output, 'channels.ts'), 'utf8')).toContain('catalog');
    expect(readFileSync(path.join(output, 'schemas.ts'), 'utf8')).toContain('PingRequest');
    const channels = readFileSync(path.join(output, 'channels.ts'), 'utf8');
    expect(channels).toContain("streamActions: ['watch'] as const");
    const streams = readFileSync(path.join(output, 'streams.ts'), 'utf8');
    expect(streams).toContain("export { createPynectClient as createClient } from 'pynect';");
    expect(readFileSync(path.join(output, 'index.ts'), 'utf8')).toContain(
      "export * from './streams.js';",
    );

    const schema = JSON.parse(readFileSync(path.join(output, 'asyncapi.json'), 'utf8'));
    expect(schema.operations.watch['x-pynect-stream']).toBe(true);
    expect(schema.operations.watch.reply.messages).toHaveLength(1);
  }, 60_000);
});
