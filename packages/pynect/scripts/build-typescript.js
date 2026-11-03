#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
fs.rmSync(output, { recursive: true, force: true });

const tsc = require.resolve('typescript/bin/tsc');
const result = spawnSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.json')], {
  cwd: root,
  stdio: 'inherit',
});

if (result.error) throw result.error;
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
} else {
  const pythonOutput = path.join(output, 'py');
  fs.mkdirSync(pythonOutput, { recursive: true });
  for (const script of ['pynect_codegen.py', 'pynect_worker.py']) {
    fs.copyFileSync(path.join(root, 'scripts', script), path.join(pythonOutput, script));
  }
}
