'use strict';

import fs from 'fs';
import path from 'path';
import { Command, Option } from 'commander';
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type FormattingOptions,
  type ParseError,
} from 'jsonc-parser';
import { ensurePynectPython } from '../env/PyfigAdapter';

type StringMap = Record<string, string>;

interface ParameterInfo {
  name: string;
  type?: string;
  kind?: string;
  optional?: boolean;
  has_default?: boolean;
}

interface InspectionItem {
  name: string;
  type?: string;
  return_type?: string;
  parameters?: ParameterInfo[];
  docstring?: string;
  excluded?: boolean;
  exported?: boolean;
  fully_annotated?: boolean;
  read_only?: boolean;
}

interface InspectionClass extends InspectionItem {
  methods?: InspectionItem[];
  static_methods?: InspectionItem[];
  class_methods?: InspectionItem[];
  properties?: InspectionItem[];
  members?: InspectionItem[];
}

interface Inspection {
  error?: string;
  version?: string;
  inspection?: string;
  functions: InspectionItem[];
  classes: InspectionClass[];
  constants: InspectionItem[];
}

interface CodegenConfig {
  modules?: string[];
  src?: string[];
  include?: string[];
  exclude?: string[];
  annotated?: boolean;
  exported?: boolean;
  all?: boolean;
  clear?: boolean;
  list?: boolean;
  configure?: boolean;
  tsconfig?: string;
  outDir?: string;
  typeOverrides?: StringMap;
  signatureOverrides?: StringMap;
}

interface ProjectContext {
  projectDirectory: string;
  workspaceDirectory: string;
}

interface CodegenOptions extends ProjectContext {
  modules: string[];
  src: string[];
  include: string[];
  exclude: string[];
  annotated: boolean;
  exported: boolean;
  all: boolean;
  clear: boolean;
  list: boolean;
  configure: boolean;
  tsconfig?: string;
  outDir: string;
  typeOverrides: StringMap;
  signatureOverrides: StringMap;
}

interface CodegenMetadata {
  modules: Record<string, {
    version: string | null;
    inspection: string;
    generatedAt: string;
  }>;
}

// The package compiles to CommonJS, so keep this import native for ESM-only Pacwich.
const importPacwich = new Function('return import("pacwich")') as () => Promise<typeof import('pacwich')>;

const ROOT = path.resolve(__dirname, '../..');
const INSPECTOR = path.join(ROOT, 'python', 'type_inspector.py');
const MODULE_RE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;
const SKIPPED_DIRECTORIES = new Set([
  '.git', '.hg', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox',
  '.venv', '__pycache__', 'build', 'dist', 'node_modules', 'site-packages',
  'venv',
]);

export function createCodegenCommand(name = 'codegen'): Command {
  const collect = (value: string, previous: string[] = []): string[] => [...previous, value];
  const command = new Command(name)
    .description('Generate TypeScript declarations from Python modules. With no modules, discover project sources. Public members are included by default; excludes always win.')
    .argument('[modules...]', 'Python modules to inspect')
    .option('--config <file>', 'JSON configuration file', 'pynect.config.json')
    .option('--cwd <dir>', 'project or workspace directory', process.cwd())
    .option('--src <dir>', 'Python source root used for discovery and imports; repeatable', collect)
    .option('--include <glob>', 'restrict output to a glob; repeatable', collect)
    .option('--exclude <glob>', 'exclude a glob; repeatable', collect)
    .option('--annotated', 'emit only fully annotated members')
    .option('--exported', 'emit only @export-marked members')
    .option('--all', 'regenerate every cached module')
    .option('--list', 'list cached modules')
    .option('--clear', 'remove generated declarations')
    .option('--no-configure', 'do not update tsconfig.json, package.json, or .gitignore')
    .option('--tsconfig <file>', 'tsconfig file to update when auto-configuration is enabled')
    .addOption(new Option('--out <dir>', 'generated declaration directory').env('PYNECT_OUT_DIR'))
    .addHelpText('after', '\nConfiguration precedence: CLI, environment, JSON config, defaults.\nRepeat --include or --exclude to provide multiple patterns.\nAuto-configuration is enabled by default; use --no-configure to leave project files unchanged.');
  command.action(async () => {
    const options = await resolveOptions(command);
    await executeCodegen(options);
  });
  return command;
}

function nearestPackageDirectory(startDirectory: string): string | null {
  let directory = path.resolve(startDirectory);
  while (true) {
    if (fs.existsSync(path.join(directory, 'package.json'))) {return directory;}
    const parent = path.dirname(directory);
    if (parent === directory) {return null;}
    directory = parent;
  }
}

function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isPublicModule(moduleName: string): boolean {
  return moduleName.split('.').every(part => !part.startsWith('_'));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function resolveProjectContext(startDirectory: string): Promise<ProjectContext> {
  const cwd = path.resolve(startDirectory);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`Project directory is not a directory: ${cwd}`);
  }
  const packageDirectory = nearestPackageDirectory(cwd);
  if (!packageDirectory) {return { projectDirectory: cwd, workspaceDirectory: cwd };}

  try {
    const { createFileSystemProject, setLogLevel } = await importPacwich();
    setLogLevel('silent');
    const project = createFileSystemProject({
      rootDirectory: packageDirectory,
      includeRootWorkspace: true,
      disableExecutableConfigs: true,
    });
    const candidates = [project.rootWorkspace, ...project.workspaces]
      .map(workspace => workspace.isRoot
        ? project.rootDirectory
        : path.resolve(project.rootDirectory, workspace.path))
      .filter((directory, index, all) => all.indexOf(directory) === index)
      .filter(directory => containsPath(directory, cwd))
      .sort((left, right) => right.length - left.length);
    return {
      projectDirectory: project.rootDirectory,
      workspaceDirectory: candidates[0] ?? packageDirectory,
    };
  } catch (error) {
    console.warn(`pynect codegen: Pacwich project detection failed; using ${packageDirectory}. ${errorMessage(error)}`);
    return { projectDirectory: packageDirectory, workspaceDirectory: packageDirectory };
  }
}

async function resolveOptions(program: Command): Promise<CodegenOptions> {
  const values = program.opts<Record<string, unknown>>();
  const context = await resolveProjectContext(String(values['cwd']));
  const configPath = path.resolve(context.workspaceDirectory, String(values['config']));
  let config: CodegenConfig = {};
  if (fs.existsSync(configPath)) {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Codegen config must be a JSON object');
    config = parsed as CodegenConfig;
  }
  const chosen = <T>(name: string, fallback: T): T => {
    const source = program.getOptionValueSource(name);
    const configured = config[name as keyof CodegenConfig] as T | undefined;
    return source === 'cli' || source === 'env' ? values[name] as T : (configured ?? fallback);
  };
  const modules: unknown = program.args.length ? program.args : (config.modules ?? []);
  const src: unknown = chosen('src', config.src ?? []);
  const include: unknown = chosen('include', []);
  const exclude: unknown = chosen('exclude', []);
  if (![modules, src, include, exclude].every(value => Array.isArray(value) && value.every(item => typeof item === 'string'))) {
    throw new Error('modules, src, include, and exclude must be string arrays in the codegen config');
  }
  const typeOverrides = config.typeOverrides ?? {};
  const signatureOverrides = config.signatureOverrides ?? {};
  if (![typeOverrides, signatureOverrides].every(value => value && !Array.isArray(value) && typeof value === 'object' && Object.values(value).every(item => typeof item === 'string'))) {
    throw new Error('typeOverrides and signatureOverrides must map names to strings');
  }
  const outSource = program.getOptionValueSource('out');
  const configuredOut = outSource === 'cli' || outSource === 'env'
    ? String(values['out'])
    : (config.outDir ?? '.pynect/generated');
  const out: CodegenOptions = {
    modules: modules as string[],
    src: src as string[],
    include: include as string[],
    exclude: exclude as string[],
    annotated: chosen('annotated', false), exported: chosen('exported', false),
    all: chosen('all', false), clear: chosen('clear', false), list: chosen('list', false),
    configure: chosen('configure', true),
    tsconfig: chosen('tsconfig', undefined),
    outDir: path.resolve(context.workspaceDirectory, configuredOut),
    typeOverrides,
    signatureOverrides,
    ...context,
  };
  for (const name of out.modules) if (!MODULE_RE.test(name)) throw new Error(`Invalid Python module: ${name}`);
  out.src = out.src.map(source => path.resolve(context.workspaceDirectory, String(source)));
  return out;
}

function containsPython(root: string): boolean {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return false;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.') && !entry.name.startsWith('_')) {
          pending.push(path.join(directory, entry.name));
        }
      } else if (entry.isFile() && entry.name.endsWith('.py')) {
        return true;
      }
    }
  }
  return false;
}

function defaultSourceRoots(baseDirectory: string): string[] {
  const conventional = ['src', 'python']
    .map(directory => path.resolve(baseDirectory, directory))
    .filter(containsPython);
  return conventional.length ? conventional : [baseDirectory];
}

function discoverModules(sourceRoots: string[]): string[] {
  const modules = new Set<string>();
  for (const root of sourceRoots) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new Error(`Python source root is not a directory: ${root}`);
    }
    const visit = (directory: string, parts: string[]): void => {
      const entries = fs.readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
          visit(path.join(directory, entry.name), [...parts, entry.name]);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.py')) continue;
        const name = entry.name.slice(0, -3);
        if (name.startsWith('_') || name.endsWith('_example')) continue;
        const qualified = [...parts, name].join('.');
        if (MODULE_RE.test(qualified)) modules.add(qualified);
      }
    };
    visit(root, []);
  }
  return [...modules].sort();
}

function localModulePath(moduleName: string, sourceRoots: string[]): string | null {
  const relative = moduleName.split('.');
  for (const root of sourceRoots) {
    const moduleFile = path.join(root, ...relative) + '.py';
    if (fs.existsSync(moduleFile) && fs.statSync(moduleFile).isFile()) return moduleFile;
    const packageFile = path.join(root, ...relative, '__init__.py');
    if (fs.existsSync(packageFile) && fs.statSync(packageFile).isFile()) return packageFile;
  }
  return null;
}

function glob(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(value);
}

function selected(item: InspectionItem, qualified: string, options: CodegenOptions): boolean {
  if (!item || item.excluded || item.name.startsWith('_')) return false;
  const names = [item.name, qualified];
  if (options.exclude.some(p => names.some(n => glob(p, n)))) return false;
  if (options.include.length && !options.include.some(p => names.some(n => glob(p, n)))) return false;
  if (options.annotated && !item.fully_annotated) return false;
  return !options.exported || item.exported === true;
}

function filterInspection(moduleName: string, inspection: Inspection, options: CodegenOptions): Inspection {
  for (const key of ['functions', 'classes', 'constants'] as const) {
    inspection[key] = (inspection[key] || []).filter(item => selected(item, `${moduleName}.${item.name}`, options));
  }
  for (const cls of inspection.classes) {
    for (const key of ['methods', 'static_methods', 'class_methods', 'properties', 'members'] as const) {
      cls[key] = (cls[key] || []).filter(item => selected(item, `${moduleName}.${cls.name}.${item.name}`, options));
    }
  }
  return inspection;
}

function hasDeclarations(inspection: Inspection): boolean {
  return (['functions', 'classes', 'constants'] as const).some(key => inspection[key].length > 0);
}

const TYPE_MAP: StringMap = { str: 'string', int: 'number', float: 'number', bool: 'boolean', None: 'null',
  NoneType: 'null', bytes: 'Uint8Array', bytearray: 'Uint8Array', Any: 'unknown', object: 'PyProxy',
  type: 'PyProxy', module: 'PyProxy', datetime: 'Date', date: 'Date', Path: 'string',
  NoReturn: 'never', Never: 'never' };

function splitParams(value: string): string[] {
  const parts: string[] = []; let depth = 0; let current = '';
  for (const char of value) {
    if (char === '[') depth += 1;
    if (char === ']') depth -= 1;
    if (char === ',' && depth === 0) { parts.push(current.trim()); current = ''; } else current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function mapType(raw: unknown, overrides: StringMap = {}): string {
  const value = String(raw || 'Any').trim();
  if (typeof overrides[value] === 'string') return overrides[value];
  if (TYPE_MAP[value]) return TYPE_MAP[value];
  let match = value.match(/^Optional\[(.+)]$/);
  if (match) return `${mapType(match[1]!, overrides)} | null`;
  match = value.match(/^(?:List|Sequence|Iterable|Set|FrozenSet|list|set|tuple)\[(.+)]$/);
  if (match) return `Array<${mapType(match[1]!, overrides)}>`;
  match = value.match(/^(?:Dict|Mapping|dict)\[(.+)]$/);
  if (match) {
    const parts = splitParams(match[1]!);
    return `Record<${mapType(parts[0], overrides)}, ${mapType(parts[1], overrides)}>`;
  }
  match = value.match(/^Union\[(.+)]$/);
  if (match) return splitParams(match[1]!).map(part => mapType(part, overrides)).join(' | ');
  match = value.match(/^(.+)\s*\|\s*None$/);
  if (match) return `${mapType(match[1]!, overrides)} | null`;
  return /^[A-Za-z_]\w*$/.test(value) ? value : 'PyProxy';
}

function params(items: ParameterInfo[] | undefined, typeOverrides: StringMap): string {
  return (items || []).filter(x => !['self', 'cls'].includes(x.name)).slice(0, 30).map(x => {
    const type = mapType(x.type, typeOverrides);
    if (x.kind === 'var_positional') return `...${x.name}: ${type}[]`;
    if (x.kind === 'var_keyword') return `${x.name}?: Record<string, ${type}>`;
    return `${x.name}${x.optional || x.has_default ? '?' : ''}: ${type}`;
  }).join(', ');
}
function returns(value: string | undefined, typeOverrides: StringMap): string {
  return !value || ['None', 'NoneType'].includes(value) ? 'Promise<void>' : `Promise<${mapType(value, typeOverrides)}>`;
}
function doc(value: unknown, indent = '  '): string {
  const text = String(value || '').replace(/\*\//g, '* /').replace(/\s+/g, ' ').slice(0, 240);
  return text ? `${indent}/** ${text} */\n` : '';
}

function signature(qualifiedName: string, item: InspectionItem, options: CodegenOptions): string {
  const override = options.signatureOverrides[qualifiedName];
  if (override !== undefined) {
    if (typeof override !== 'string' || !/^\s*\([\s\S]*\)\s*:\s*\S/.test(override)) {
      throw new Error(`Invalid signature override for ${qualifiedName}; expected "(args): returnType"`);
    }
    return override.trim().replace(/;$/, '');
  }
  return `(${params(item.parameters, options.typeOverrides)}): ${returns(item.return_type, options.typeOverrides)}`;
}

function functionType(qualifiedName: string, item: InspectionItem, options: CodegenOptions): string {
  const value = signature(qualifiedName, item, options);
  const match = value.match(/^(\([\s\S]*\))\s*:\s*([\s\S]+)$/);
  if (!match) throw new Error(`Could not convert signature for ${qualifiedName} to a callable type`);
  return `${match[1]} => ${match[2]}`;
}

function generate(moduleName: string, inspection: Inspection, options: CodegenOptions): string {
  if (inspection.error) throw new Error(inspection.error);
  const lines = [
    '// Generated by pynect codegen. Do not edit.',
    `declare module 'pynect/${moduleName}' {`,
    `  type PyProxy = import('pynect').PyProxy;`,
    `  type PynectFunction<F extends (...args: never[]) => Promise<unknown>> = import('pynect').PynectFunction<F>;`,
  ];
  for (const x of inspection.constants) lines.push(`${doc(x.docstring)}  export const ${x.name}: ${mapType(x.type, options.typeOverrides)};`);
  for (const x of inspection.functions) lines.push(`${doc(x.docstring)}  export const ${x.name}: PynectFunction<${functionType(`${moduleName}.${x.name}`, x, options)}>;`);
  for (const cls of inspection.classes) {
    const properties = cls.properties ?? [];
    const members = cls.members ?? [];
    const methods = cls.methods ?? [];
    const staticMethods = cls.static_methods ?? [];
    const classMethods = cls.class_methods ?? [];
    lines.push(`${doc(cls.docstring)}  export class ${cls.name} {`, '    constructor(...args: unknown[]);');
    for (const x of [...properties, ...members]) lines.push(`${doc(x.docstring, '    ')}    ${x.read_only ? 'readonly ' : ''}${x.name}: Promise<${mapType(x.type, options.typeOverrides)}>;`);
    for (const x of [...methods, ...staticMethods, ...classMethods]) {
      const isStatic = staticMethods.includes(x) || classMethods.includes(x);
      lines.push(`${doc(x.docstring, '    ')}    ${isStatic ? 'static ' : ''}${x.name}: PynectFunction<${functionType(`${moduleName}.${cls.name}.${x.name}`, x, options)}>;`);
    }
    lines.push('  }');
  }
  lines.push('}', ''); return lines.join('\n');
}

const metaPath = (options: CodegenOptions): string => path.join(options.outDir, '_meta.json');
const registryPath = (options: CodegenOptions): string => path.join(options.outDir, '_registry.d.ts');
function loadMeta(options: CodegenOptions): CodegenMetadata {
  try { return JSON.parse(fs.readFileSync(metaPath(options), 'utf8')) as CodegenMetadata; } catch { return { modules: {} }; }
}
function saveMeta(options: CodegenOptions, meta: CodegenMetadata): void {
  fs.mkdirSync(options.outDir, { recursive: true });
  fs.writeFileSync(metaPath(options), `${JSON.stringify(meta, null, 2)}\n`);
}
const declarationPath = (options: CodegenOptions, name: string): string => path.join(options.outDir, `${name.replace(/\./g, '-')}.d.ts`);
function saveRegistry(options: CodegenOptions, moduleNames: string[]): void {
  const lines = [
    '// Generated by pynect codegen. Do not edit.',
    "import 'pynect';",
    '',
    "declare module 'pynect' {",
    '  interface PynectModules {',
    ...moduleNames.sort().map(name => `    '${name}': typeof import('pynect/${name}');`),
    '  }',
    '}',
    '',
    'export {};',
    '',
  ];
  fs.mkdirSync(options.outDir, { recursive: true });
  fs.writeFileSync(registryPath(options), lines.join('\n'));
}

function readJsonc(filePath: string): { text: string; value: Record<string, unknown> } {
  const text = fs.readFileSync(filePath, 'utf8');
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    const details = errors.map(error => `${printParseErrorCode(error.error)} at offset ${error.offset}`).join(', ');
    throw new Error(`Could not parse ${filePath}: ${details}`);
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`Expected a JSON object in ${filePath}`);
  }
  return { text, value: value as Record<string, unknown> };
}

function formattingOptions(text: string): FormattingOptions {
  const indentation = text.match(/\r?\n([ \t]+)\S/)?.[1] ?? '  ';
  return {
    insertSpaces: !indentation.includes('\t'),
    tabSize: indentation.includes('\t') ? 1 : indentation.length,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  };
}

function setJsoncValue(filePath: string, text: string, propertyPath: (string | number)[], value: unknown): boolean {
  const edits = modify(text, propertyPath, value, { formattingOptions: formattingOptions(text) });
  if (!edits.length) {return false;}
  fs.writeFileSync(filePath, applyEdits(text, edits));
  return true;
}

function configureTsconfig(options: CodegenOptions): string | null {
  const filePath = options.tsconfig
    ? path.resolve(options.workspaceDirectory, options.tsconfig)
    : path.join(options.workspaceDirectory, 'tsconfig.json');
  if (!fs.existsSync(filePath)) {return null;}
  const { text, value } = readJsonc(filePath);
  const relative = path.relative(path.dirname(filePath), options.outDir).replace(/\\/g, '/');
  const pattern = `${relative || '.'}/**/*.d.ts`;
  const current = value.include;
  if (current !== undefined && !Array.isArray(current)) {
    throw new Error(`Expected "include" to be an array in ${filePath}`);
  }
  const include = Array.isArray(current) ? [...current] : ['**/*'];
  if (include.includes(pattern)) {return null;}
  include.push(pattern);
  return setJsoncValue(filePath, text, ['include'], include) ? filePath : null;
}

function configurePackageScript(options: CodegenOptions): string | null {
  const filePath = path.join(options.workspaceDirectory, 'package.json');
  if (!fs.existsSync(filePath)) {return null;}
  const { text, value } = readJsonc(filePath);
  if (value.scripts !== undefined && (!value.scripts || Array.isArray(value.scripts) || typeof value.scripts !== 'object')) {
    throw new Error(`Expected "scripts" to be an object in ${filePath}`);
  }
  const scripts = value.scripts as Record<string, unknown> | undefined;
  if (scripts?.['codegen'] !== undefined) {return null;}
  return setJsoncValue(filePath, text, ['scripts', 'codegen'], 'pynect codegen') ? filePath : null;
}

function configureGitignore(options: CodegenOptions): string | null {
  const relative = path.relative(options.workspaceDirectory, options.outDir).replace(/\\/g, '/');
  if (relative !== '.pynect/generated') {return null;}
  const filePath = path.join(options.workspaceDirectory, '.gitignore');
  const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const entry = '/.pynect/';
  if (text.split(/\r?\n/).some(line => line.trim() === entry)) {return null;}
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const separator = text && !text.endsWith('\n') && !text.endsWith('\r') ? eol : '';
  fs.writeFileSync(filePath, `${text}${separator}${entry}${eol}`);
  return filePath;
}

function configureProject(options: CodegenOptions): void {
  for (const changed of [configureTsconfig(options), configurePackageScript(options), configureGitignore(options)]) {
    if (changed) {console.log(`configured ${path.relative(options.workspaceDirectory, changed)}`);}
  }
}

async function executeCodegen(options: CodegenOptions): Promise<void> {
  if (!options.src.length) options.src = defaultSourceRoots(options.workspaceDirectory);
  const meta = loadMeta(options);
  if (options.list) { console.log(Object.keys(meta.modules).sort().join('\n') || 'No generated modules.'); return; }
  if (options.clear) {
    for (const name of Object.keys(meta.modules)) fs.rmSync(declarationPath(options, name), { force: true });
    fs.rmSync(registryPath(options), { force: true });
    saveMeta(options, { modules: {} });
    return;
  }
  const modules = options.all
    ? Object.keys(meta.modules)
    : (options.modules.length ? options.modules : discoverModules(options.src));
  const publicModules = modules.filter(isPublicModule);
  if (!publicModules.length) throw new Error('No public Python modules were found. Packages and modules beginning with "_" are ignored.');
  const { client } = await ensurePynectPython({
    projectRoot: options.workspaceDirectory,
  });
  for (const name of publicModules.sort()) {
    const pythonPath = [...options.src, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    const localPath = localModulePath(name, options.src);
    const inspectorArgs = localPath ? [INSPECTOR, '--file', localPath, name] : [INSPECTOR, name];
    const result = client.pythonSync(inspectorArgs, {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, PYTHONPATH: pythonPath },
    });
    const stdout = String(result.stdout ?? '');
    const stderr = String(result.stderr ?? '');
    if (result.status !== 0) throw new Error(stderr.trim() || `Inspector failed for ${name}`);
    const inspection = filterInspection(name, JSON.parse(stdout) as Inspection, options);
    const target = declarationPath(options, name);
    if (!hasDeclarations(inspection)) {
      fs.rmSync(target, { force: true });
      delete meta.modules[name];
      console.log(`${name} -> skipped (no selected public members)`);
      continue;
    }
    fs.mkdirSync(options.outDir, { recursive: true }); fs.writeFileSync(target, generate(name, inspection, options));
    meta.modules[name] = { version: inspection.version || null, inspection: inspection.inspection || 'runtime', generatedAt: new Date().toISOString() };
    console.log(`${name} -> ${path.relative(options.workspaceDirectory, target)}`);
  }
  saveMeta(options, meta);
  saveRegistry(options, Object.keys(meta.modules));
  if (options.configure) {configureProject(options);}
}
