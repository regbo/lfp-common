import { fileURLToPath } from 'node:url';
import { ExamplePython } from './generated/example-python.ts';

const pythonProject = fileURLToPath(new URL('../../python', import.meta.url));
await using python = new ExamplePython({
	autoClose: false,
	cwd: pythonProject,
	project: '.',
});
const calculator = await python.calculator;

console.log(await calculator.greet('Pynect'));
console.log(await calculator.greet('Pynect', result => `WOW: ${result}`));
console.log(`6 + 7 = ${await calculator.add(6, 7)}`);
console.log('Fibonacci:', await calculator.fibonacci(10));
