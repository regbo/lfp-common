'use strict';

const { ensurePynectPython } = require('./pyfig');

async function ensurePython(options = {}) {
  const { python } = await ensurePynectPython({
    autoInstallPython: options.autoInstall,
    managedPython: options.version,
    pythonPath: options.pythonPath,
    projectRoot: options.projectRoot,
  });
  return python;
}

async function detectPython(explicit) {
  try {
    return await ensurePython({ autoInstall: false, pythonPath: explicit });
  } catch {
    return null;
  }
}

module.exports = { detectPython, ensurePython };
