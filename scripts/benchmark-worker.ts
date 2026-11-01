import path from 'node:path';
import { createPyEnvironment, type PyfigOptions } from '../src/index.ts';

interface BenchmarkRequest {
  cacheDir: string;
  managedPython?: string;
  projectRoot: string;
  requiresPython?: string;
  dependencies?: string[];
  verifyModules?: string[];
}

interface PortableEnvironment {
  managed: boolean;
  pythonSource: 'cache' | 'external';
  pythonVersion: string;
  uvSource: 'cache' | 'external';
  uvVersion: string;
  virtualEnvironment: string;
}

const encodedRequest = process.env['PYFIG_BENCHMARK_REQUEST'];
if (!encodedRequest) throw new Error('PYFIG_BENCHMARK_REQUEST is required.');
const request = JSON.parse(encodedRequest) as BenchmarkRequest;
const options: PyfigOptions = {
  cacheDir: request.cacheDir,
  dependencies: request.dependencies,
  managedPython: request.managedPython,
  projectRoot: request.projectRoot,
  requiresPython: request.requiresPython,
};

const pyenv = createPyEnvironment(options);
const started = performance.now();
const environment = await pyenv.prepare();
const apiMs = performance.now() - started;

let verificationMs = 0;
if (request.verifyModules?.length) {
  const verificationStarted = performance.now();
  const imports = request.verifyModules.map((name) => `import ${name}`).join('; ');
  const result = pyenv.uvSync(
    ['run', '--', 'python', '-c', imports],
    { encoding: 'utf8' },
  );
  verificationMs = performance.now() - verificationStarted;
  if (result.status !== 0) {
    throw new Error(String(result.stderr || `module verification exited ${result.status}`));
  }
}

const portable: PortableEnvironment = {
  managed: environment.managed,
  pythonSource: isBelow(environment.python.baseExecutable, request.cacheDir)
    ? 'cache'
    : 'external',
  pythonVersion: environment.python.version,
  uvSource: isBelow(environment.uv.executable, request.cacheDir) ? 'cache' : 'external',
  uvVersion: environment.uv.version,
  virtualEnvironment: portableLocation(
    environment.python.virtualEnvironment,
    request.projectRoot,
  ),
};

process.stdout.write(JSON.stringify({ apiMs, environment: portable, verificationMs }));

function isBelow(candidate: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function portableLocation(candidate: string | null, projectRoot: string): string {
  if (!candidate) return 'none';
  if (!isBelow(candidate, projectRoot)) return 'external';
  return path.relative(projectRoot, candidate).split(path.sep).join('/');
}
