import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { pyfig } from 'pyfig';
import { z } from 'zod';
import type { CodegenRequest } from './_generated/codegen';
import { workerOptionsSchema } from './_generated/schema';
import { resolvePythonPath } from './utils/pyfig';
import { resolvePythonPackage } from './utils/python-package';

const moduleConfigSchema = z.union([z.array(z.string()), z.record(z.string(), z.string())]);

export const codegenOptionsSchema = z.object({
  ...workerOptionsSchema.shape,
  root: z.string().default('.').describe('Python project root.'),
  config: z.string().optional().describe('Standalone codegen configuration file.'),
  module: z.array(z.string()).optional().describe('Python module or alias=module mapping.'),
  out: z.string().optional().describe('Generated TypeScript output path.'),
  className: z.string().optional().describe('Generated project class name.'),
  project: z.union([z.string(), z.literal(false)]).optional().describe('uv project path or false.'),
  with: z.array(z.string()).optional().describe('Additional uv requirements.'),
  withEditable: z.array(z.string()).optional().describe('Additional editable uv requirements.'),
  withRequirements: z.array(z.string()).optional().describe('Requirements or lock files.'),
  uvArgs: z.array(z.string()).optional().describe('Additional uv run arguments.'),
  autoClose: z.boolean().optional().describe('Allow the host to exit while Python is running.'),
  startupTimeoutMs: z.number().int().positive().optional().describe('Worker startup timeout.'),
  callTimeoutMs: z.number().int().nonnegative().optional().describe('Default RPC timeout.'),
});

export const setupDevOptionsSchema = z.object({
  root: z.string().default('.').describe('Python project root.'),
  dryRun: z.boolean().default(false).describe('Describe changes without writing files.'),
});

const configSchema = codegenOptionsSchema.omit({ root: true, config: true, module: true }).extend({
  modules: moduleConfigSchema,
});

export type CodegenOptions = z.input<typeof codegenOptionsSchema>;
export type SetupDevOptions = z.input<typeof setupDevOptionsSchema>;

export async function generateBindings(input: CodegenOptions): Promise<string> {
  const options = codegenOptionsSchema.parse(input);
  const root = path.resolve(options.root);
  const configured = loadConfig(root, options.config);
  const modules = resolveModules(options.module ?? configured.modules);
  const className = options.className
    ?? (typeof configured.className === 'string' ? configured.className : undefined)
    ?? deriveClassName(modules);
  const out = options.out
    ?? (typeof configured.out === 'string' ? configured.out : undefined)
    ?? 'pynect.generated.ts';
  const merged = { ...configured, ...withoutUndefined(options) };
  const bridge = Object.fromEntries([
    'project', 'with', 'withEditable', 'withRequirements', 'uvArgs',
    'validatePydantic', 'autoClose', 'startupTimeoutMs', 'callTimeoutMs',
  ].flatMap(key => merged[key] === undefined ? [] : [[key, merged[key]]]));
  const request = { root, modules, className, out, bridge } satisfies CodegenRequest;
  return runPython(request);
}

export function setupDevelopment(input: SetupDevOptions): readonly string[] {
  const { root: rootInput, dryRun } = setupDevOptionsSchema.parse(input);
  const root = path.resolve(rootInput);
  const settingsPath = path.join(root, '.vscode', 'settings.json');
  const extensionsPath = path.join(root, '.vscode', 'extensions.json');
  const settings = readJsonObject(settingsPath);
  settings['runOnSave.ignoreFilesBy'] = uniqueStrings(settings['runOnSave.ignoreFilesBy'], '.gitignore');
  const commands = Array.isArray(settings['runOnSave.commands']) ? settings['runOnSave.commands'] : [];
  const command = 'pynect codegen generate';
  settings['runOnSave.commands'] = [
    ...commands.filter(item => !isCommand(item, command)),
    {
      globMatch: '**/*.py', command, runIn: 'backend', workingDirectoryAsCWD: true,
      commandDebounce: 250, async: false,
      runningStatusMessage: 'Generating Pynect bindings...',
      finishStatusMessage: 'Pynect bindings generated',
    },
  ];
  const extensions = readJsonObject(extensionsPath);
  extensions.recommendations = uniqueStrings(extensions.recommendations, 'pucelle.run-on-save');
  const changes = new Map([[settingsPath, formatJson(settings)], [extensionsPath, formatJson(extensions)]]);
  const changed = [...changes].filter(([file, content]) => !existsSync(file) || readFileSync(file, 'utf8') !== content);
  if (!dryRun) for (const [file, content] of changed) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
  }
  if (!changed.length) return ['Development setup is already current'];
  return changed.map(([file]) => `${dryRun ? 'Would update' : 'Updated'} ${path.relative(root, file)}`);
}

function loadConfig(root: string, configuredPath?: string): Record<string, unknown> {
  if (configuredPath) return parseConfig(path.resolve(root, configuredPath), true);
  for (let directory = root; ; directory = path.dirname(directory)) {
    for (const name of ['pyproject.toml', 'package.json']) {
      const file = path.join(directory, name);
      if (existsSync(file)) {
        const value = parseConfig(file, false);
        if (Object.keys(value).length) return value;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
  }
  return {};
}

function parseConfig(file: string, standalone: boolean): Record<string, unknown> {
  const document = file.endsWith('.toml')
    ? parseToml(readFileSync(file, 'utf8'))
    : JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const nested = file.endsWith('.toml')
    ? nestedObject(document, ['tool', 'pynect', 'codegen'])
    : nestedObject(document, ['pynect', 'codegen']);
  const value = nested ?? (standalone ? document : {});
  return configSchema.partial().parse(value);
}

function resolveModules(value: unknown): Record<string, string> {
  if (!value) throw new Error('At least one module must be configured');
  if (!Array.isArray(value)) return { ...moduleConfigSchema.parse(value) } as Record<string, string>;
  const result: Record<string, string> = {};
  for (const request of value) {
    const [left, right] = request.includes('=') ? request.split('=', 2) : [request.split('.').at(-1)!, request];
    if (!left || !right || result[left]) throw new Error(`Invalid or duplicate module alias: ${request}`);
    result[left] = right;
  }
  return result;
}

function deriveClassName(modules: Record<string, string>): string {
  const aliases = Object.keys(modules);
  if (aliases.length !== 1) throw new Error('--class-name or className is required when generating multiple modules');
  const name = aliases[0]!.split(/[^A-Za-z0-9]+/u).filter(Boolean).map(part => part[0]!.toUpperCase() + part.slice(1)).join('');
  return name.endsWith('Python') ? name : `${name}Python`;
}

async function runPython(request: CodegenRequest): Promise<string> {
  const environment = await pyfig({ cwd: request.root });
  const pythonPath = await resolvePythonPath(environment);
  const worker = resolvePythonPackage(__dirname);
  const child = await environment.uv.spawn(
    'run', '--no-project', '--python', pythonPath,
    worker.editable ? '--with-editable' : '--with', worker.requirement,
    '--', 'python', '-m', 'pynect_worker.codegen', JSON.stringify(request),
    {
      cwd: request.root,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  return new Promise((resolve, reject) => {
    let stdout = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', chunk => { stdout += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`Python codegen exited with ${code ?? 1}`)));
  });
}

function nestedObject(value: unknown, names: readonly string[]): Record<string, unknown> | undefined {
  let current = value;
  for (const name of names) {
    if (!current || typeof current !== 'object' || !(name in current)) return undefined;
    current = (current as Record<string, unknown>)[name];
  }
  return current && typeof current === 'object' ? current as Record<string, unknown> : undefined;
}

function withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
function readJsonObject(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Expected a JSON object: ${file}`);
  return value as Record<string, unknown>;
}
function uniqueStrings(value: unknown, addition: string): string[] {
  return [...new Set([...(Array.isArray(value) ? value.filter(item => typeof item === 'string') : []), addition])];
}
function isCommand(value: unknown, command: string): boolean {
  return !!value && typeof value === 'object' && (value as Record<string, unknown>).command === command;
}
function formatJson(value: Record<string, unknown>): string { return `${JSON.stringify(value, null, 2)}\n`; }
