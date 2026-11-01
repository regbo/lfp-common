'use strict';

const path = require('path');
const fs = require('fs');

const REQUIRED_PYFIG_FUNCTIONS = [
  'createPyfig',
];

function loadPyfig() {
  const configured = process.env.PYNECT_PYFIG_PATH;
  if (configured) {
    return requireCompatiblePyfig(path.resolve(configured), 'PYNECT_PYFIG_PATH');
  }
  let packageError;
  try {
    return requireCompatiblePyfig('pyfig', 'installed pyfig package');
  } catch (error) {
    packageError = error;
  }

  // During coordinated source development, a published but older package can
  // resolve successfully. Prefer the sibling build when its API is compatible.
  const sibling = path.resolve(__dirname, '..', '..', 'pyfig', 'dist', 'cjs', 'index.js');
  if (fs.existsSync(sibling)) {
    return requireCompatiblePyfig(sibling, 'sibling pyfig build');
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
  const hint = explicit || process.env.PYNECT_PROJECT_ROOT || process.env.INIT_CWD;
  return hint ? path.resolve(hint) : loadPyfig().resolveProjectRoot(process.cwd());
}

function pynectPyfigOptions(options = {}) {
  const pyfig = loadPyfig();
  const installPython = options.autoInstallPython ?? parseBoolean(
    process.env.PYNECT_INSTALL_PYTHON ?? process.env.PYNECT_AUTO_INSTALL,
    true,
  );
  return {
    projectRoot: projectRoot(options.projectRoot),
    python: options.pythonPath || process.env.PYNECT_PYTHON || '',
    pythonRange: options.pythonRange || process.env.PYNECT_REQUIRES_PYTHON ||
      pyfig.DEFAULT_PYTHON_RANGE,
    managedPython: options.managedPython || process.env.PYNECT_MANAGED_PYTHON ||
      process.env.PYNECT_PYTHON_VERSION || pyfig.DEFAULT_MANAGED_PYTHON,
    uvVersion: options.uvVersion || process.env.PYNECT_UV_VERSION || pyfig.DEFAULT_UV_VERSION,
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

function createPynectPyfig(options = {}) {
  return loadPyfig().createPyfig(pynectPyfigOptions(options));
}

async function ensurePynectPython(options = {}) {
  const client = createPynectPyfig(options);
  const python = assertEmbeddable(await client.pythonInfo());
  return { client, python };
}

async function ensurePynectEnvironment(options = {}) {
  const client = createPynectPyfig(options);
  const environment = await client.prepare();
  assertEmbeddable(environment.python);
  return { client, environment };
}

module.exports = {
  createPynectPyfig,
  ensurePynectEnvironment,
  ensurePynectPython,
  projectRoot,
};
