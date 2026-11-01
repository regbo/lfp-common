'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const addon = path.join(ROOT, 'build', 'Release', 'pynect_addon.node');
const heldAddon = path.join(ROOT, 'build', 'Release', 'pynect_addon.local-smoke.node');
if (!fs.existsSync(addon)) throw new Error(`Local addon is missing at ${addon}`);
if (fs.existsSync(heldAddon)) throw new Error(`Temporary addon already exists at ${heldAddon}`);

fs.renameSync(addon, heldAddon);
try {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'smoke-python-boundary.js')], {
    cwd: ROOT,
    env: { ...process.env, PYNECT_SKIP_BUILD: '1' },
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Staged prebuild smoke test failed with exit code ${result.status}.`);
  }
} finally {
  if (fs.existsSync(heldAddon)) fs.renameSync(heldAddon, addon);
}
