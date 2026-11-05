import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { GenerateOptions } from '@chanx-js/codegen';
import { pyfigOptionsSchema } from 'pyfig';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

const importTargetSchema = z.string()
  .trim()
  .regex(
    /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/u,
    'app must use the form "module:object".',
  );

export const pynectPyfigOptionsSchema = pyfigOptionsSchema.unwrap()
  .omit({ cwd: true })
  .readonly()
  .describe('Pyfig options; Pynect supplies the Python project directory as cwd.');

export type PynectPyfigOptions = z.input<typeof pynectPyfigOptionsSchema>;

export const pynectPythonSchema = z.union([
  z.string().trim().min(1).describe('Exact Python executable path.'),
  pynectPyfigOptionsSchema,
]).describe('An exact Python executable path or options resolved through Pyfig.');

export type PynectPython = z.input<typeof pynectPythonSchema>;

const projectConfigSchema = z.object({
  app: importTargetSchema.optional().describe('ASGI app as module:object.'),
  out: z.string().trim().min(1).optional().describe('Generated output directory.'),
  name: z.string().trim().min(1).optional().describe('Generated project name override.'),
  python: pynectPythonSchema.optional(),
});

export const projectOptionsSchema = projectConfigSchema.extend({
  root: z.string().trim().min(1).default('.').describe('Python project directory.'),
}).readonly();

export type ProjectOptions = z.input<typeof projectOptionsSchema>;

const validationModes = [
  'none',
  'zod',
] as const satisfies readonly NonNullable<GenerateOptions['validation']>[];
const fileConfigSchema = projectConfigSchema.extend({
  app: importTargetSchema.default('server:app'),
  validation: z.enum(validationModes).default('none'),
  format: z.boolean().default(false),
}).strict();

/** Resolve direct options over `[tool.pynect]`, then apply project-derived defaults. */
export function resolveProject(input: ProjectOptions = {}) {
  const options = projectOptionsSchema.parse(input);
  const pyprojectPath = findPyproject(path.resolve(options.root));
  const root = path.dirname(pyprojectPath);
  const document = parseToml(readFileSync(pyprojectPath, 'utf8')) as Record<string, unknown>;
  const projectTable = objectAt(document, ['project']);
  const toolConfig = objectAt(document, ['tool', 'pynect']) ?? {};
  const configured = fileConfigSchema.parse(toolConfig);
  const declaredName = z.string().trim().min(1).parse(projectTable?.name);
  const name = options.name ?? configured.name ?? declaredName;
  const slug = slugify(name);
  const out = options.out ?? configured.out ?? path.join('_generated', slug);
  const outDir = path.resolve(root, out);
  const python = options.python ?? configured.python;

  return Object.freeze({
    app: options.app ?? configured.app,
    format: configured.format,
    name,
    outDir,
    pyprojectPath,
    ...(python === undefined ? {} : { python }),
    root,
    schemaPath: path.join(outDir, 'asyncapi.json'),
    slug,
    validation: configured.validation,
  });
}

export type PynectProject = ReturnType<typeof resolveProject>;

function findPyproject(start: string): string {
  for (let directory = start; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'pyproject.toml');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
  }
  throw new Error(`Could not find pyproject.toml from ${start}.`);
}

function objectAt(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current && typeof current === 'object' && !Array.isArray(current)
    ? current as Record<string, unknown>
    : undefined;
}

function slugify(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '');
  if (!slug) throw new Error(`Project name cannot form a generated directory: ${JSON.stringify(name)}.`);
  return slug;
}
