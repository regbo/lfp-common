import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const monorepo = JSON.parse(
  await readFile(path.resolve(root, '..', '..', 'package.json'), 'utf8'),
) as { packageManager: string };
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'optionkit-packed-'));
const consumer = path.join(temporaryRoot, 'consumer');

try {
  const packed = run([
    'bun',
    'pm',
    'pack',
    '--ignore-scripts',
    '--destination',
    temporaryRoot,
    '--quiet',
  ], root);
  const reportedArchive = packed.stdout.trim().split(/\r?\n/u).at(-1);
  if (!reportedArchive) throw new Error('bun pm pack did not report an archive path.');
  const archive = path.resolve(root, reportedArchive);
  await mkdir(consumer);
  await writeFile(path.join(consumer, 'package.json'), `${JSON.stringify({
    name: 'packed-consumer',
    private: true,
    type: 'module',
    packageManager: monorepo.packageManager,
  }, null, 2)}\n`, 'utf8');
  run(['bun', 'add', archive], consumer);
  const installedManifest = await readFile(path.join(
    consumer,
    'node_modules',
    'optionkit',
    'package.json',
  ), 'utf8');
  if (installedManifest.includes('catalog:')) {
    throw new Error('The packed manifest still contains unresolved catalog references.');
  }
  await writeFile(path.join(consumer, 'cli.mjs'), `
import { createOptionKit } from 'optionkit';

const { f, z } = await createOptionKit({ moduleUrl: import.meta.url });
const input = z.object({
  uv: z.string().default('>=0.10,<1').describe('uv request.'),
  python: z.string().optional().describe('Python request.'),
  debug: z.boolean().default(false).describe('Write diagnostics.'),
  tags: z.array(z.string()).optional().describe('Tags as a JSON array.'),
  labels: z.array(z.string()).optional().describe('Labels as shell words.'),
  settings: z.record(z.string(), z.string()).optional().describe('Settings as a JSON object.'),
});
const command = f.command({ name: 'resolve', description: 'Resolve runtimes.' })
  .input(input)
  .output(z.object({
    tags: z.array(z.string()).optional(),
    labels: z.array(z.string()).optional(),
    settings: z.record(z.string(), z.string()).optional(),
  }))
  .render(output => JSON.stringify(output))
  .handler(input => input);
await command.parseAsync(process.argv);
`.trimStart(), 'utf8');

  const manifestBefore = await readFile(path.join(consumer, 'package.json'));
  const lockBefore = await readFile(path.join(consumer, 'bun.lock'));
  const result = run(['bun', 'run', 'cli.mjs', '--help'], consumer);
  const help = result.stdout.replace(/\s+/gu, ' ');
  assertIncludes(help, '-u, --uv <value>');
  assertIncludes(help, 'env: PACKED_CONSUMER_UV');
  assertIncludes(help, '-p, --python <value>');
  assertIncludes(help, '-d, --debug');

  const structured = run(['bun', 'run', 'cli.mjs'], consumer, {
    ...process.env,
    PACKED_CONSUMER_TAGS: '["one","two"]',
    PACKED_CONSUMER_LABELS: 'one, "two words", three\\,four',
    PACKED_CONSUMER_SETTINGS: '{"PORT":"3000"}',
  });
  const parsed = JSON.parse(structured.stdout) as unknown;
  if (JSON.stringify(parsed) !== JSON.stringify({
    tags: ['one', 'two'],
    labels: ['one', 'two words', 'three,four'],
    settings: { PORT: '3000' },
  })) {
    throw new Error(`Packed structured environment parsing returned: ${structured.stdout}`);
  }

  const manifestAfter = await readFile(path.join(consumer, 'package.json'));
  const lockAfter = await readFile(path.join(consumer, 'bun.lock'));
  if (!manifestBefore.equals(manifestAfter) || !lockBefore.equals(lockAfter)) {
    throw new Error('The lazy install changed the consumer manifest or lockfile.');
  }

  console.log('Packed lazy-install smoke test passed.');
} finally {
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  if (!path.basename(resolvedTemporaryRoot).startsWith('optionkit-packed-')) {
    throw new Error(`Refusing to remove unexpected directory: ${resolvedTemporaryRoot}`);
  }
  await rm(resolvedTemporaryRoot, { recursive: true, force: true });
}

function run(
  command: string[],
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): { stderr: string; stdout: string } {
  const result = Bun.spawnSync(command, { cwd, env, stderr: 'pipe', stdout: 'pipe' });
  const stderr = result.stderr.toString();
  const stdout = result.stdout.toString();
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(' ')} failed with exit ${result.exitCode}:\n${stderr}${stdout}`);
  }
  return { stderr, stdout };
}

function assertIncludes(value: string, expected: string): void {
  if (!value.includes(expected)) {
    throw new Error(`Expected output to include ${JSON.stringify(expected)}:\n${value}`);
  }
}
