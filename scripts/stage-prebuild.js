'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const buildMetadataPath = path.join(ROOT, 'build', 'pynect-python.json');
const addonPath = path.join(ROOT, 'build', 'Release', 'pynect_addon.node');
const destination = path.resolve(
  process.argv[2] || path.join(ROOT, 'prebuilds', `${process.platform}-${process.arch}`),
);

const build = JSON.parse(fs.readFileSync(buildMetadataPath, 'utf8'));
const match = String(build.pythonVersion).match(/^(\d+)\.(\d+)/u);
if (!match) throw new Error(`Invalid Python version in ${buildMetadataPath}: ${build.pythonVersion}`);
if (!fs.existsSync(addonPath)) throw new Error(`Native addon is missing at ${addonPath}`);

const metadata = {
  schemaVersion: 1,
  platform: process.platform,
  architecture: process.arch,
  pythonMajorMinor: `${match[1]}.${match[2]}`,
  napi: 8,
};
if (process.platform === 'linux') {
  const glibc = process.report?.getReport().header.glibcVersionRuntime;
  if (!glibc) throw new Error('Linux prebuild staging requires a detectable glibc runtime.');
  metadata.glibc = glibc;
}

fs.mkdirSync(destination, { recursive: true });
fs.copyFileSync(addonPath, path.join(destination, 'pynect_addon.node'));
fs.writeFileSync(
  path.join(destination, 'pynect-prebuild.json'),
  `${JSON.stringify(metadata, null, 2)}\n`,
  'utf8',
);
console.log(`Staged ${process.platform}-${process.arch} Python ${metadata.pythonMajorMinor} prebuild.`);
