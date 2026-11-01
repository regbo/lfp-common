'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BUILD_DIRECTORY = path.join(ROOT, 'build');
const METADATA = path.join(BUILD_DIRECTORY, 'pynect-python.json');
let lastLoadError;

function normalize(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function matchingAddonPath() {
  const selected = process.env.PYNECT_PYTHON;
  if (!selected || !fs.existsSync(METADATA)) return null;
  try {
    const metadata = JSON.parse(fs.readFileSync(METADATA, 'utf8'));
    if (
      metadata.schemaVersion !== 1 ||
      normalize(metadata.pythonExecutable) !== normalize(selected)
    ) return null;
    return path.join(
      BUILD_DIRECTORY,
      metadata.buildType === 'Debug' ? 'Debug' : 'Release',
      'pynect_addon.node',
    );
  } catch {
    return null;
  }
}

function loads() {
  lastLoadError = undefined;
  const addon = matchingAddonPath();
  if (!addon || !fs.existsSync(addon)) return false;
  try {
    require(addon);
    return true;
  } catch (error) {
    lastLoadError = error;
    return false;
  }
}

function build() {
  console.log(`[pynect native] Building with active runtime ${process.execPath}`);
  const result = spawnSync(process.execPath, [path.join(__dirname, 'build-native.js')], {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Native addon build failed with exit code ${result.status}.`);
  }
  if (!loads()) {
    const detail = lastLoadError instanceof Error ? ` ${lastLoadError.message}` : '';
    throw new Error(`Native addon did not load after it was built.${detail}`);
  }
}

async function main() {
  const force = process.env.PYNECT_FORCE_BUILD === '1';
  if (!force && loads()) return;
  if (process.env.PYNECT_SKIP_BUILD === '1') {
    throw new Error('Native addon is unavailable and building is disabled by PYNECT_SKIP_BUILD=1.');
  }

  fs.mkdirSync(BUILD_DIRECTORY, { recursive: true });
  const { withLock } = await import('loqkit');
  await withLock(
    { buildDirectory: BUILD_DIRECTORY },
    async () => build(),
    async () => force || !loads(),
    {
      key: `pynect-native:${normalize(BUILD_DIRECTORY)}`,
      name: 'Pynect native build',
      namespace: 'pynect',
    },
  );
}

main().catch(error => {
  console.error(`[pynect native] ${error.message}`);
  process.exitCode = 1;
});
