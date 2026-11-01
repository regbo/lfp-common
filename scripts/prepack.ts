import { runBun } from './command.ts';

const skip = process.env['PYFIG_SKIP_PREPACK'] === '1';
if (skip) {
  console.log('Skipping prepack verification and build because PYFIG_SKIP_PREPACK=1.');
} else {
  // Local package creation remains fail-closed unless the trusted tag workflow
  // explicitly supplies its workflow-wide bypass.
  runBun(['run', 'verify']);
  runBun(['run', 'build']);
}
