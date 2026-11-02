'use strict';

process.env.PYNECT_PREFER_LOCAL ??= '1';

const path = require('path');
const { spawnSync } = require('child_process');
const { preparePython } = require('./python');

const ROOT = path.resolve(__dirname, '..');

async function main() {
  if (process.argv.includes('--auto-close-child')) {
    await verifyAutomaticClose();
    return;
  }
  const { runtime, environment } = await preparePython({ projectRoot: ROOT });
  const { python } = environment;
  const expected = normalize(python.executable);
  const pynect = require('../dist');

  const selected = runtime.uvSync(
    ['run', '--', 'python', '-c', 'import sys; print(sys.executable)'],
    { encoding: 'utf8' },
  );
  assertSuccess(selected, 'Pyfig Python uvSync run');
  assertSamePython(selected.stdout.trim(), expected, 'Pyfig Python uvSync run');

  const uvPip = runtime.uvSync(
    ['pip', 'list', '--format', 'json'],
    { encoding: 'utf8' },
  );
  assertSuccess(uvPip, 'PyfigClient.uvSync pip');

  const inspector = runtime.uvSync(
    ['run', '--', 'python', path.join(ROOT, 'python', 'type_inspector.py'), 'json'],
    { encoding: 'utf8' },
  );
  assertSuccess(inspector, 'codegen inspector');
  JSON.parse(inspector.stdout);
  const callbackInspection = runtime.uvSync(
    ['run', '--', 'python', path.join(ROOT, 'python', 'type_inspector.py'), 'pynect_callback_fixture'],
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

  const worker = runtime.uvSync(
    ['run', '--', 'python', path.join(ROOT, 'python', 'isolated_worker.py')],
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

  const bridge = await pynect.createPythonBridge({
    projectRoot: ROOT,
    allowUnsafeCode: true,
    logLevel: 'error',
    pythonModulePaths: [path.join(ROOT, 'tests', 'fixtures')],
    threadPool: { size: 1 },
    callbacks: { maxDepth: 2 },
  });
  try {
    if (!bridge.isOpen) throw new Error('Python bridge did not report itself as open.');
    await assertRejects(
      () => pynect.createPythonBridge({ projectRoot: ROOT }),
      /Only one embedded PythonBridge can be active/,
      'single embedded bridge ownership',
    );
    const embedded = await bridge.eval('__import__("sys").executable');
    assertSamePython(embedded, expected, 'embedded CPython');
    const fixture = await bridge.import('pynect_callback_fixture');
    const asyncCallback = async value => {
      await Promise.resolve();
      return value * 3;
    };
    if (await fixture.invoke(asyncCallback, 4) !== 12) {
      throw new Error('Async JavaScript callback returned the wrong value.');
    }
    await fixture.retain(asyncCallback);
    await assertRejects(
      () => fixture.invoke_retained(4),
      /callback.*(?:disposed|registered)|(?:disposed|registered).*callback/i,
      'settled callback lifetime',
    );

    const reentrantCallback = async value => fixture.double(value);
    if (await fixture.invoke(reentrantCallback, 5) !== 10) {
      throw new Error('Reentrant JavaScript callback returned the wrong value.');
    }

    let recursiveCallback;
    recursiveCallback = async depth => {
      if (depth <= 0) return 0;
      return fixture.invoke(recursiveCallback, depth - 1);
    };
    await assertRejects(
      () => fixture.invoke(recursiveCallback, 2),
      /recursion depth 3 exceeds the configured maximum of 2/,
      'callback recursion limit',
    );
  } finally {
    await bridge.close();
  }
  if (bridge.isOpen) throw new Error('Python bridge remained open after close().');

  const autoClose = spawnSync(process.execPath, [__filename, '--auto-close-child'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  assertSuccess(autoClose, 'automatic bridge close');
  if (!autoClose.stdout.includes('AUTO_CLOSE_OK')) {
    throw new Error(`Automatic bridge close was not observed: ${autoClose.stdout}`);
  }

  console.log(`Python ${python.version} boundary verified: ${python.executable}`);
}

async function verifyAutomaticClose() {
  const pynect = require('../dist');
  const bridge = await pynect.createPythonBridge({ logLevel: 'error' });
  if (normalize(bridge.config.projectRoot) !== normalize(ROOT)) {
    throw new Error(`Bridge discovered ${bridge.config.projectRoot}; expected ${ROOT}.`);
  }
  let reported = false;
  process.on('beforeExit', () => {
    if (!bridge.isOpen && !reported) {
      reported = true;
      console.log('AUTO_CLOSE_OK');
    }
  });
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
