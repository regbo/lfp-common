import { createVenv } from '../../src';

const mode = process.argv[2];
const venv = createVenv({ project: false });

if (mode === 'startup-signal') {
  const signal = process.argv[3] as NodeJS.Signals | undefined;
  if (!signal) throw new Error('The shutdown signal is required.');
  console.log(JSON.stringify({ startup: true }));
  setInterval(() => undefined, 60_000);
  const starting = venv.ready();
  process.emit(signal, signal);
  await starting.catch(() => undefined);
} else {
  const python = await venv.import('os');
  const pythonPid = await python.getpid();

  if (typeof pythonPid !== 'number') throw new TypeError('Python did not return its process id.');
  console.log(JSON.stringify({ pythonPid }));

  if (mode === 'signal') {
    // Keep another handle active to prove the signal handler exits only after cleanup.
    setInterval(() => undefined, 60_000);
    const signal = process.argv[3] as NodeJS.Signals | undefined;
    if (!signal) throw new Error('The shutdown signal is required.');
    process.emit(signal, signal);
  }
}
