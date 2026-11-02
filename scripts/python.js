'use strict';

const path = require('path');
const { Python, resolveProjectRoot } = require('pyfig');

function projectRoot(explicit) {
  const hint = explicit || process.env.PYNECT_PROJECT_ROOT || process.env.INIT_CWD;
  return hint ? path.resolve(hint) : resolveProjectRoot(process.cwd());
}

function createPython(options = {}) {
  return new Python({
    ...options,
    projectRoot: projectRoot(options.projectRoot),
    requireEmbedding: true,
    requireGil: true,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
}

async function preparePython(options = {}) {
  const runtime = createPython(options);
  const environment = await runtime.prepare();
  if (!environment.python.embedding) {
    throw new Error(
      `Python ${environment.python.version} at ${environment.python.executable} is missing ` +
      'Python.h or its CPython embedding library.',
    );
  }
  return { runtime, environment };
}

module.exports = { createPython, preparePython, projectRoot };
