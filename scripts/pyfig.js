'use strict';

const path = require('path');
const fs = require('fs');

let cachedPyfig;

const REQUIRED_PYFIG_FUNCTIONS = [
  'ensureEnvironment',
  'ensureVirtualEnvironment',
  'pipSpawn',
  'pipSpawnSync',
  'pythonSpawn',
  'pythonSpawnSync',
  'uvSpawnSync',
];

function loadPyfig() {
  if (cachedPyfig) return cachedPyfig;
  const configured = process.env.PYNECT_PYFIG_PATH;
  if (configured) {
    cachedPyfig = requireCompatiblePyfig(path.resolve(configured), 'PYNECT_PYFIG_PATH');
    return cachedPyfig;
  }
  let packageError;
  try {
    cachedPyfig = requireCompatiblePyfig('pyfig', 'installed pyfig package');
    return cachedPyfig;
  } catch (error) {
    packageError = error;
  }

  // During coordinated source development, a published but older package can
  // resolve successfully. Prefer the sibling build when its API is compatible.
  const sibling = path.resolve(__dirname, '..', '..', 'pyfig', 'dist', 'cjs', 'index.js');
  if (fs.existsSync(sibling)) {
    cachedPyfig = requireCompatiblePyfig(sibling, 'sibling pyfig build');
    return cachedPyfig;
  }

  const detail = packageError instanceof Error ? ` ${packageError.message}` : '';
  throw new Error(
    `Pynect requires a Pyfig release with the venv and spawn API.${detail}`,
    { cause: packageError },
  );
}

function requireCompatiblePyfig(specifier, label) {
  const candidate = require(specifier);
  const missing = REQUIRED_PYFIG_FUNCTIONS.filter(name => typeof candidate[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(`${label} is missing required exports: ${missing.join(', ')}.`);
  }
  return candidate;
}

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new TypeError(`Invalid boolean value: ${value}`);
}

function projectRoot(explicit) {
  return path.resolve(
    explicit || process.env.PYNECT_PROJECT_ROOT || process.env.INIT_CWD || process.cwd(),
  );
}

function pynectPyfigOptions(options = {}) {
  const installPython = options.autoInstallPython ??
    parseBoolean(process.env.PYNECT_AUTO_INSTALL, true);
  return {
    projectRoot: projectRoot(options.projectRoot),
    python: options.pythonPath || process.env.PYNECT_PYTHON || '',
    pythonRange: options.pythonRange || '>=3.10.0 <4.0.0',
    managedPython: options.managedPython || process.env.PYNECT_PYTHON_VERSION || '3.12',
    uvVersion: options.uvVersion || process.env.PYNECT_UV_VERSION || '0.13.6',
    requireEmbedding: true,
    requireGil: true,
    installPython,
    installUv: options.autoInstallUv ?? parseBoolean(process.env.PYNECT_INSTALL_UV, true),
    createVirtualEnvironment: options.autoCreateVirtualEnvironment ??
      parseBoolean(process.env.PYNECT_CREATE_VIRTUAL_ENVIRONMENT, true),
    env: options.env ? { ...process.env, ...options.env } : process.env,
  };
}

function assertEmbeddable(python) {
  if (!python.embedding) {
    throw new Error(
      `Python ${python.version} at ${python.executable} is missing Python.h or its CPython ` +
      'embedding library.',
    );
  }
  return python;
}

async function ensurePynectPython(options = {}) {
  const pyfig = loadPyfig();
  const pyfigOptions = pynectPyfigOptions(options);
  const python = assertEmbeddable(await pyfig.ensureVirtualEnvironment(pyfigOptions));
  return { python, pyfigOptions };
}

async function ensurePynectEnvironment(options = {}) {
  const pyfig = loadPyfig();
  const pyfigOptions = pynectPyfigOptions(options);
  const environment = await pyfig.ensureEnvironment(pyfigOptions);
  assertEmbeddable(environment.python);
  return { environment, pyfigOptions };
}

module.exports = {
  ensurePynectEnvironment,
  ensurePynectPython,
  loadPyfig,
  projectRoot,
  pynectPyfigOptions,
};
