import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { compile } from 'json-schema-to-typescript';

interface SchemaDocument {
  readonly $defs: {
    readonly CodegenRequest: Record<string, unknown>;
    readonly ServerOptions: Record<string, unknown>;
    readonly WorkerOptions: Record<string, unknown>;
  };
  readonly 'x-pynect-protocol': {
    readonly messageKinds: readonly string[];
    readonly operations: readonly string[];
    readonly version: number;
    readonly websocketSubprotocol: string;
    readonly wireValueTypes: readonly string[];
  };
}

const packageRoot = path.resolve(__dirname, '..', '..');
const generatedRoot = path.join(__dirname, '_generated');
const check = process.argv.includes('--check');
const banner = '// Generated from pynect_worker Pydantic models. Do not edit directly.\n';
const typeOptions = {
  bannerComment: '',
  format: true,
  style: { singleQuote: true, trailingComma: 'all' as const },
};

void main();

async function main(): Promise<void> {
  const schema = loadSchema();
  const protocol = schema['x-pynect-protocol'];
  const outputs = new Map<string, string>([
    [path.join(generatedRoot, 'codegen.ts'), await generateType(
      schema.$defs.CodegenRequest,
      'CodegenRequest',
    )],
    [path.join(generatedRoot, 'protocol.ts'), generateProtocol(protocol)],
    [path.join(generatedRoot, 'schema.ts'), await generateSchema(schema)],
  ]);
  const stale = [...outputs].filter(([file, content]) => {
    try {
      return readFileSync(file, 'utf8') !== content;
    } catch {
      return true;
    }
  });

  if (check && stale.length > 0) {
    throw new Error(
      `Generated Pynect schemas are stale: ${stale.map(([file]) => path.relative(packageRoot, file)).join(', ')}`,
    );
  }
  if (!check) {
    for (const [file, content] of stale) writeFileSync(file, content, 'utf8');
  }
}

function loadSchema(): SchemaDocument {
  const result = spawnSync(
    'uv',
    ['run', '--locked', 'python', '-m', 'pynect_worker.schema'],
    { cwd: packageRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Pynect schema generation exited with ${result.status ?? 1}.`);
  }
  return JSON.parse(result.stdout) as SchemaDocument;
}

function generateProtocol(value: SchemaDocument['x-pynect-protocol']): string {
  return `${banner}
export const PROTOCOL_VERSION = ${value.version} as const;
export const WEBSOCKET_SUBPROTOCOL = ${JSON.stringify(value.websocketSubprotocol)} as const;

export const MESSAGE_KIND = ${constantMap(value.messageKinds)} as const;
export type MessageKind = typeof MESSAGE_KIND[keyof typeof MESSAGE_KIND];

export const RPC_OPERATION = ${constantMap(value.operations)} as const;
export type RpcOperation = typeof RPC_OPERATION[keyof typeof RPC_OPERATION];

export const WIRE_VALUE_TYPE = ${constantMap(value.wireValueTypes)} as const;
export type WireValueType = typeof WIRE_VALUE_TYPE[keyof typeof WIRE_VALUE_TYPE];
`;
}

async function generateSchema(value: SchemaDocument): Promise<string> {
  const workerSchema = JSON.stringify(value.$defs.WorkerOptions, null, 2);
  const serverSchema = JSON.stringify(value.$defs.ServerOptions, null, 2);
  const types = await compile(
    omitTitles({
      ...value.$defs.WorkerOptions,
      $defs: { ServerOptions: value.$defs.ServerOptions },
    }) as Record<string, unknown>,
    'WorkerOptions',
    { ...typeOptions, unreachableDefinitions: true },
  );
  return `${banner}
import { z } from 'zod';

${types.trim()}

const workerOptionsJsonSchema = ${workerSchema} as const;
const serverOptionsJsonSchema = ${serverSchema} as const;

export const workerOptionsSchema = z.fromJSONSchema(workerOptionsJsonSchema) as z.ZodObject<{
  validatePydantic: z.ZodDefault<z.ZodBoolean>;
}>;
export const serverOptionsSchema = z.fromJSONSchema(
  serverOptionsJsonSchema,
) as z.ZodType<ServerOptions>;

// Assert the generated runtime schema remains assignable to the generated static type.
const _workerOptionsTypecheck: z.ZodType<WorkerOptions> = workerOptionsSchema;
void _workerOptionsTypecheck;
`;
}

async function generateType(value: Record<string, unknown>, name: string): Promise<string> {
  const generated = await compile(omitTitles(value) as Record<string, unknown>, name, typeOptions);
  return `${banner}\n${generated.trim()}\n`;
}

function omitTitles(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitTitles);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'title')
      .map(([key, entry]) => [key, omitTitles(entry)]),
  );
}

function constantMap(values: readonly string[]): string {
  return JSON.stringify(
    Object.fromEntries(values.map(value => [toCamelCase(value), value])),
    null,
    2,
  );
}

function toCamelCase(value: string): string {
  return value.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}
