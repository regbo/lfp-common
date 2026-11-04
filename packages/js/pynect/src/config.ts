import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

const importTargetSchema = z.string()
  .trim()
  .regex(
    /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/u,
    'app must use the form "module:object".',
  );

const fileConfigSchema = z.object({
  app: importTargetSchema.default('server:app'),
  out: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  python: z.string().trim().min(1).optional(),
  uv: z.string().trim().min(1).optional(),
  debug: z.boolean().default(false),
  validation: z.enum(['none', 'zod']).default('none'),
  format: z.boolean().default(false),
}).strict();

export const projectOptionsSchema = z.object({
  root: z.string().trim().min(1).default('.').describe('Python project directory.'),
  app: importTargetSchema.optional().describe('ASGI app as module:object.'),
  out: z.string().trim().min(1).optional().describe('Generated output directory.'),
  name: z.string().trim().min(1).optional().describe('Project and IPC name override.'),
  python: z.string().trim().min(1).optional().describe('Python request passed to Pyfig.'),
  uv: z.string().trim().min(1).optional().describe('uv executable or version constraint.'),
  debug: z.boolean().optional().describe('Write Pyfig and Python worker diagnostics to stderr.'),
}).readonly();

export type ProjectOptions = z.input<typeof projectOptionsSchema>;

export interface PynectProject {
  readonly app: string;
  readonly debug: boolean;
  readonly format: boolean;
  readonly ipcEnvironmentVariable: string;
  readonly name: string;
  readonly outDir: string;
  readonly pyprojectPath: string;
  readonly python?: string;
  readonly root: string;
  readonly schemaPath: string;
  readonly slug: string;
  readonly uv?: string;
  readonly validation: 'none' | 'zod';
}

/** Resolve direct options over `[tool.pynect]`, then apply project-derived defaults. */
export function resolveProject(input: ProjectOptions = {}): PynectProject {
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

  return Object.freeze({
    app: options.app ?? configured.app,
    debug: options.debug ?? configured.debug,
    format: configured.format,
    ipcEnvironmentVariable: `${slug.replaceAll('-', '_').toUpperCase()}_IPC_PATH`,
    name,
    outDir,
    pyprojectPath,
    ...(options.python ?? configured.python
      ? { python: options.python ?? configured.python }
      : {}),
    root,
    schemaPath: path.join(outDir, 'asyncapi.json'),
    slug,
    ...(options.uv ?? configured.uv ? { uv: options.uv ?? configured.uv } : {}),
    validation: configured.validation,
  });
}

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
