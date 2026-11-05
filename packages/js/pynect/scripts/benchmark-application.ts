import { fileURLToPath } from 'node:url';

const pythonPathEnvironment = 'PYNECT_BENCHMARK_PYTHON_PATH';
let pythonPath = process.env[pythonPathEnvironment]?.trim();
if (!pythonPath) {
  const { pyfig } = await import('pyfig');
  const runtime = await pyfig({
    cwd: fileURLToPath(new URL('../../../py/pynect-example/', import.meta.url)),
  });
  await runtime.python.resolve();
  pythonPath = runtime.python.path;
  if (!pythonPath) throw new Error('Pyfig resolved Python without exposing its executable path.');
  process.env[pythonPathEnvironment] = pythonPath;
}

if (process.argv.includes('--child')) console.log('BENCHMARK_START bun');
await import('./benchmark-application-runner.js');
