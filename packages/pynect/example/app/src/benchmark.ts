import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { ExamplePython } from './generated/example-python.ts';

const OBJECT_COUNT = 2_000;
const WARM_RUNS = 5;
const pythonProject = fileURLToPath(new URL('../../python', import.meta.url));

interface Measurement {
  readonly name: string;
  readonly milliseconds: number;
  readonly matches: number;
}

async function measure(
  name: string,
  operation: () => Promise<ReadonlyArray<unknown>>,
): Promise<Measurement> {
  const start = performance.now();
  const result = await operation();
  return {
    name,
    milliseconds: performance.now() - start,
    matches: result.length,
  };
}

function print(measurement: Measurement): void {
  console.log(
    `${measurement.name.padEnd(24)} ${measurement.milliseconds.toFixed(2).padStart(10)} ms  `
      + `${measurement.matches} matches`,
  );
}

async function main(): Promise<void> {
  await using coldNativePython = new ExamplePython({
    autoClose: false,
    cwd: pythonProject,
    project: '.',
  });
  const coldNativeStart = performance.now();
  const coldNativeCalculator = await coldNativePython.calculator;
  const coldNativeValues = await coldNativeCalculator.create_benchmark_objects(OBJECT_COUNT);
  const coldNative = await coldNativeCalculator.filter_benchmark_objects_native(coldNativeValues);
  print({
    name: 'cold native Python',
    milliseconds: performance.now() - coldNativeStart,
    matches: coldNative.length,
  });

  await using coldCallbackPython = new ExamplePython({
    autoClose: false,
    cwd: pythonProject,
    project: '.',
  });
  const coldCallbackStart = performance.now();
  const coldCallbackCalculator = await coldCallbackPython.calculator;
  const coldCallbackValues = await coldCallbackCalculator.create_benchmark_objects(OBJECT_COUNT);
  const coldCallback = await coldCallbackCalculator.filter_benchmark_objects_callback(
    coldCallbackValues,
    value => value.active,
  );
  print({
    name: 'cold JS callback',
    milliseconds: performance.now() - coldCallbackStart,
    matches: coldCallback.length,
  });

  await using warmPython = new ExamplePython({
    autoClose: false,
    cwd: pythonProject,
    project: '.',
  });
  const calculator = await warmPython.calculator;
  const values = await calculator.create_benchmark_objects(OBJECT_COUNT);

  for (let run = 1; run <= WARM_RUNS; run += 1) {
    print(await measure(
      `warm native Python #${run}`,
      () => calculator.filter_benchmark_objects_native(values),
    ));
    print(await measure(
      `warm JS callback #${run}`,
      () => calculator.filter_benchmark_objects_callback(values, value => value.active),
    ));
  }
}

await main();
