import { runCommand } from './process.ts';

if (process.env.PYNECT_SKIP_PREPACK === '1') {
  console.log('Skipping duplicate prepack checks in the trusted publish workflow');
} else {
  await runCommand(process.execPath, ['run', 'verify'], { inherit: true });
}
