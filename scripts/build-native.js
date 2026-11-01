'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ensurePynectPython } = require('./pyfig');

const ROOT = path.resolve(__dirname, '..');

async function main() {
  const projectRoot = process.env.PYNECT_PROJECT_ROOT || process.env.INIT_CWD || ROOT;
  const { python } = await ensurePynectPython({
    projectRoot,
    pythonPath: process.env.PYNECT_PYTHON,
  });
  const embedding = python.embedding;
  const stableAbiLibrary = embedding.stableAbiLibraryPath || (
    process.platform === 'win32'
      ? path.join(embedding.libraryDirectory, 'python3.lib')
      : ''
  );
  const linkLibrary = stableAbiLibrary && fs.existsSync(stableAbiLibrary)
    ? stableAbiLibrary
    : embedding.libraryPath;
  const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js');
  const mode = process.argv.includes('--debug') ? '--debug' : '--release';
  const args = [nodeGyp, 'rebuild', mode];
  if (process.argv.includes('--verbose')) args.push('--verbose');
  console.log(`[pynect build] Python ${python.version}: ${python.executable}`);
  const env = {
    ...process.env,
    npm_config_python: python.executable,
    PYTHON: python.executable,
    PYNECT_PYTHON_INCLUDE_DIR: embedding.includeDirectory,
    PYNECT_PYTHON_LIBRARY: linkLibrary,
    PYNECT_PYTHON_LIBRARY_DIR: path.dirname(linkLibrary),
    PATH: [embedding.libraryDirectory, path.dirname(python.executable), process.env.PATH || '']
      .filter(Boolean)
      .join(path.delimiter),
  };
  const result = spawnSync(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error(`node-gyp failed with exit code ${result.status}`);
  const target = path.join(ROOT, 'build', mode === '--debug' ? 'Debug' : 'Release', 'pynect_addon.node');
  if (!fs.existsSync(target)) throw new Error(`Native addon was not created at ${target}`);
  fs.writeFileSync(
    path.join(ROOT, 'build', 'pynect-python.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      pythonExecutable: path.resolve(python.executable),
      pythonVersion: python.version,
      pythonLibrary: path.resolve(linkLibrary),
      buildType: mode === '--debug' ? 'Debug' : 'Release',
    }, null, 2)}\n`,
  );
  console.log(`[pynect build] Built ${path.relative(ROOT, target)}`);
}

main().catch(error => { console.error(`[pynect build] ${error.message}`); process.exitCode = 1; });
