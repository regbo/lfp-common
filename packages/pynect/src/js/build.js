#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const output = path.join(root, 'dist');
fs.rmSync(output, { recursive: true, force: true });

const tsc = require.resolve('typescript/bin/tsc');
run(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.json')]);
run('uv', ['build', '--out-dir', 'dist/py']);

// uv protects its build directory with a nested .gitignore, which package
// managers also interpret while packing. Remove it so the wheel is shipped.
fs.rmSync(path.join(output, 'py', '.gitignore'), { force: true });

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
