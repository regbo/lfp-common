'use strict';

const path = require('path');
const { ensurePynectEnvironment } = require('./pyfig');

const ROOT = path.resolve(__dirname, '..');

async function main() {
  const { client, environment } = await ensurePynectEnvironment({ projectRoot: ROOT });
  const { python } = environment;
  const expected = normalize(python.executable);
  const pynect = require('../dist');

  const detector = new pynect.PythonDetector({ projectRoot: ROOT });
  const detected = await detector.detect();
  assertSamePython(detected.executable, expected, 'PythonDetector');
  const probed = detector.probe(detected.executable);
  if (!probed) throw new Error('PythonDetector could not probe the selected repository Python.');
  assertSamePython(probed.executable, expected, 'PythonDetector.probe');

  const selected = client.pythonSync(
    ['-c', 'import sys; print(sys.executable)'],
    { encoding: 'utf8' },
  );
  assertSuccess(selected, 'PyfigClient.pythonSync');
  assertSamePython(selected.stdout.trim(), expected, 'PyfigClient.pythonSync');

  const pip = client.pipSync(['list', '--format', 'json'], { encoding: 'utf8' });
  assertSuccess(pip, 'PyfigClient.pipSync');

  const uvPip = client.uvSync(
    ['pip', 'list', '--format', 'json'],
    { encoding: 'utf8' },
  );
  assertSuccess(uvPip, 'PyfigClient.uvSync pip');

  const inspector = client.pythonSync(
    [path.join(ROOT, 'python', 'type_inspector.py'), 'json'],
    { encoding: 'utf8' },
  );
  assertSuccess(inspector, 'codegen inspector');
  JSON.parse(inspector.stdout);

  const worker = client.pythonSync(
    [path.join(ROOT, 'python', 'isolated_worker.py')],
    {
      encoding: 'utf8',
      input: `${JSON.stringify({
        id: 1,
        module: 'os',
        function: 'getenv',
        args: ['VIRTUAL_ENV'],
        kwargs: {},
      })}\n`,
      env: {
        ...process.env,
        PYTHONPATH: path.join(ROOT, 'python'),
        PYNECT_DISPATCHER_CONFIG: '{}',
      },
    },
  );
  assertSuccess(worker, 'isolated worker');
  const workerResult = JSON.parse(worker.stdout.trim());
  if (!workerResult.ok || normalize(workerResult.result) !== normalize(python.virtualEnvironment)) {
    throw new Error('The isolated worker did not use the Pyfig virtual environment.');
  }

  await pynect.init({
    projectRoot: ROOT,
    allowUnsafeCode: true,
    logLevel: 'error',
  });
  try {
    const embedded = await pynect.py.eval('__import__("sys").executable');
    assertSamePython(embedded, expected, 'embedded CPython');
  } finally {
    await pynect.shutdown();
  }

  console.log(`Python boundary verified: ${python.executable}`);
}

function assertSuccess(result, label) {
  if (result.status !== 0 || result.error) {
    throw new Error(`${label} failed: ${String(result.stderr || result.error?.message || result.status)}`);
  }
}

function assertSamePython(actual, expected, label) {
  if (normalize(actual) !== expected) {
    throw new Error(`${label} used ${actual}; expected ${expected}.`);
  }
}

function normalize(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

main().catch(error => {
  console.error(`[pynect smoke] ${error.message}`);
  process.exitCode = 1;
});
