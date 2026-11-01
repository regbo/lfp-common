import { appendFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { withProvisioningLock } from '../src/provision-lock.ts';

const root = process.argv[2];
if (!root) throw new Error('Expected a coordination test directory.');

const target = path.join(root, 'resource');
const completed = path.join(root, 'completed');
await mkdir(target, { recursive: true });

const result = await withProvisioningLock({
  key: `test:${target}`,
  timeoutMs: 10_000,
  check: async () => {
    try {
      await stat(completed);
      return 'existing';
    } catch {
      return null;
    }
  },
  mutate: async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await appendFile(path.join(root, 'mutations.txt'), `${process.pid}\n`);
    await appendFile(completed, 'done');
    return 'created';
  },
});

process.stdout.write(result);
