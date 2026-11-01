'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  computeNativeFingerprint,
  nativeBuildConfig,
} = require('./native-fingerprint');

const ROOT = path.resolve(__dirname, '..');
const buildMetadataPath = path.join(ROOT, 'build', 'pynect-python.json');
const addonPath = path.join(ROOT, 'build', 'Release', 'pynect_addon.node');
const destination = path.resolve(
  process.argv[2] || path.join(ROOT, 'prebuilds', `${process.platform}-${process.arch}`),
);

const build = JSON.parse(fs.readFileSync(buildMetadataPath, 'utf8'));
const match = String(build.pythonVersion).match(/^(\d+)\.(\d+)/u);
if (!match) throw new Error(`Invalid Python version in ${buildMetadataPath}: ${build.pythonVersion}`);
const minimum = nativeBuildConfig.pythonMinimumVersion.split('.').map(Number);
const buildVersion = [Number(match[1]), Number(match[2])];
if (
  buildVersion[0] < minimum[0] ||
  (buildVersion[0] === minimum[0] && buildVersion[1] < minimum[1])
) {
  throw new Error(
    `Python ${build.pythonVersion} cannot build ${nativeBuildConfig.pythonAbi}, which requires ` +
    `${nativeBuildConfig.pythonMinimumVersion} or newer.`,
  );
}
if (!fs.existsSync(addonPath)) throw new Error(`Native addon is missing at ${addonPath}`);
const nativeFingerprint = computeNativeFingerprint(ROOT);
const expectedFingerprint = process.env.PYNECT_EXPECTED_NATIVE_FINGERPRINT;
if (expectedFingerprint && expectedFingerprint !== nativeFingerprint) {
  throw new Error(
    `Native fingerprint changed after planning: ${expectedFingerprint} -> ${nativeFingerprint}`,
  );
}

const metadata = {
  schemaVersion: 2,
  platform: process.platform,
  architecture: process.arch,
  pythonMinimumVersion: nativeBuildConfig.pythonMinimumVersion,
  pythonAbi: nativeBuildConfig.pythonAbi,
  pythonLibraryName: process.platform === 'win32' ? 'python3.dll' : 'libpython3.so',
  napi: nativeBuildConfig.napi,
  nativeFingerprint,
};
if (process.platform === 'linux') {
  const glibc = process.report?.getReport().header.glibcVersionRuntime;
  if (!glibc) throw new Error('Linux prebuild staging requires a detectable glibc runtime.');
  metadata.glibc = glibc;
  const linked = spawnSync('patchelf', ['--print-needed', addonPath], { encoding: 'utf8' });
  if (linked.status !== 0) throw new Error(String(linked.stderr || 'patchelf failed'));
  const dependency = linked.stdout
    .split(/\r?\n/u)
    .map(line => line.trim())
    .find(item => /^libpython.*\.so(?:\.|$)/u.test(item));
  if (!dependency) throw new Error('Could not find the linked Python shared library.');
  const rewritten = spawnSync(
    'patchelf',
    ['--replace-needed', dependency, metadata.pythonLibraryName, addonPath],
    { encoding: 'utf8' },
  );
  if (rewritten.status !== 0) throw new Error(String(rewritten.stderr || 'patchelf failed'));
}
if (process.platform === 'darwin') {
  const linked = spawnSync('otool', ['-L', addonPath], { encoding: 'utf8' });
  if (linked.status !== 0) throw new Error(String(linked.stderr || 'otool failed'));
  const dependency = linked.stdout
    .split(/\r?\n/u)
    .map(line => line.trim().split(/\s+/u)[0])
    .find(item => item && (
      /libpython.*\.dylib$/u.test(item) ||
      /Python\.framework\/Versions\/[^/]+\/Python$/u.test(item)
    ));
  if (!dependency) throw new Error('Could not find the linked Python dylib.');
  metadata.pythonLibraryName = 'libpython3.dylib';
  const rewritten = spawnSync(
    'install_name_tool',
    ['-change', dependency, `@loader_path/${metadata.pythonLibraryName}`, addonPath],
    { encoding: 'utf8' },
  );
  if (rewritten.status !== 0) {
    throw new Error(String(rewritten.stderr || 'install_name_tool failed'));
  }
}

fs.mkdirSync(destination, { recursive: true });
fs.copyFileSync(addonPath, path.join(destination, 'pynect_addon.node'));
fs.writeFileSync(
  path.join(destination, 'pynect-prebuild.json'),
  `${JSON.stringify(metadata, null, 2)}\n`,
  'utf8',
);
console.log(
  `Staged ${process.platform}-${process.arch} ${metadata.pythonAbi} prebuild ` +
  `(Python >=${metadata.pythonMinimumVersion}).`,
);
