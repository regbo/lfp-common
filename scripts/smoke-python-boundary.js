'use strict';

process.env.PYNECT_PREFER_LOCAL ??= '1';

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
  const callbackInspection = client.pythonSync(
    [path.join(ROOT, 'python', 'type_inspector.py'), 'pynect_callback_fixture'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PYTHONPATH: path.join(ROOT, 'tests', 'fixtures'),
      },
    },
  );
  assertSuccess(callbackInspection, 'callback type inspector');
  const inspectedCallback = JSON.parse(callbackInspection.stdout).functions
    .find(item => item.name === 'invoke')?.parameters?.[0]?.type;
  if (inspectedCallback !== 'Callable[[Any], Any]') {
    throw new Error(`Callback annotation was inspected as ${String(inspectedCallback)}.`);
  }

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
    pythonPath_extra: [path.join(ROOT, 'tests', 'fixtures')],
    threadPool: { size: 1 },
    callbacks: { maxDepth: 2 },
  });
  try {
    const embedded = await pynect.py.eval('__import__("sys").executable');
    assertSamePython(embedded, expected, 'embedded CPython');
    const fixture = await pynect.importModule('pynect_callback_fixture');
    await assertRejects(
      () => fixture.invoke((value) => value, 1),
      /ctx\.callback\(\)/,
      'unregistered callback',
    );

    let disposedCallback;
    await pynect.withCallbacks(async ctx => {
      const asyncCallback = ctx.callback(async value => {
        await Promise.resolve();
        return value * 3;
      });
      if (await fixture.invoke(asyncCallback, 4) !== 12) {
        throw new Error('Async JavaScript callback returned the wrong value.');
      }

      const reentrantCallback = ctx.callback(async value => fixture.double(value));
      if (await fixture.invoke(reentrantCallback, 5) !== 10) {
        throw new Error('Reentrant JavaScript callback returned the wrong value.');
      }

      let recursiveCallback;
      recursiveCallback = ctx.callback(async depth => {
        if (depth <= 0) return 0;
        return fixture.invoke(recursiveCallback, depth - 1);
      });
      await assertRejects(
        () => fixture.invoke(recursiveCallback, 2),
        /recursion depth 3 exceeds the configured maximum of 2/,
        'callback recursion limit',
      );
      disposedCallback = asyncCallback;
    });
    await assertRejects(
      () => fixture.invoke(disposedCallback, 1),
      /disposed/,
      'callback context disposal',
    );
  } finally {
    await pynect.shutdown();
  }

  console.log(`Python ${python.version} boundary verified: ${python.executable}`);
}

async function assertRejects(action, pattern, label) {
  try {
    await action();
  } catch (error) {
    if (pattern.test(String(error?.message || error))) return;
    throw new Error(`${label} failed with an unexpected error: ${error?.message || error}`);
  }
  throw new Error(`${label} did not reject.`);
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
