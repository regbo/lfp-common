import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';

const archiveArgument = process.argv[2];
if (!archiveArgument) throw new TypeError('Usage: bun run release:audit -- <package.tgz>');

const archive = path.resolve(archiveArgument);
const entries: Array<Promise<{ name: string; content: Buffer }>> = [];
await tar.t({
  file: archive,
  onentry(entry) {
    if (entry.type !== 'File') {
      entry.resume();
      return;
    }
    entries.push(new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      entry.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      entry.once('error', reject);
      entry.once('end', () => resolve({ name: entry.path, content: Buffer.concat(chunks) }));
    }));
  },
});

const files = await Promise.all(entries);
const packagedManifest = files.find((entry) => entry.name === 'package/package.json');
if (!packagedManifest) throw new Error('Release archive does not contain package/package.json.');

const sourceManifest = JSON.parse(
  await readFile(path.join(import.meta.dir, '..', 'package.json'), 'utf8'),
) as { name: string; version: string };
const packed = JSON.parse(packagedManifest.content.toString('utf8')) as {
  name: string;
  version: string;
};
if (packed.name !== sourceManifest.name || packed.version !== sourceManifest.version) {
  throw new Error('Packed name or version differs from the audited source manifest.');
}

const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const emailFiles = files
  .filter((entry) => emailPattern.test(entry.content.toString('utf8')))
  .map((entry) => entry.name);
if (emailFiles.length > 0) {
  throw new Error(`Release archive contains email-shaped metadata in: ${emailFiles.join(', ')}`);
}

console.log(`Release archive audited: ${path.basename(archive)} (${files.length} files).`);
