'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(__dirname, 'native-build-config.json');
const nativeBuildConfig = Object.freeze(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));

function sourceFiles(root) {
  const nativeDirectory = path.join(root, 'src', 'native');
  const nativeSources = fs.readdirSync(nativeDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(?:cc|cpp|h)$/u.test(entry.name))
    .map(entry => path.join('src', 'native', entry.name));
  return [
    'binding.gyp',
    'scripts/build-native.js',
    'scripts/native-build-config.json',
    'scripts/native-fingerprint.js',
    'scripts/pyfig.js',
    'scripts/stage-prebuild.js',
    ...nativeSources,
  ].sort();
}

function nativeFingerprintPaths(root = ROOT) {
  return sourceFiles(root);
}

function lockRecord(lock, packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const expression = new RegExp(`^\\s*"${escaped}":\\s*(\\[[^\\r\\n]+\\]),?$`, 'gmu');
  const matches = [...lock.matchAll(expression)];
  if (matches.length !== 1 || !matches[0]?.[1]) {
    throw new Error(`Expected one resolved ${packageName} record in bun.lock.`);
  }
  return matches[0][1];
}

/** Produces a stable digest from labeled native build inputs. */
function hashNativeInputs(inputs) {
  const hash = crypto.createHash('sha256');
  for (const input of [...inputs].sort((left, right) => left.name.localeCompare(right.name))) {
    const content = Buffer.isBuffer(input.content)
      ? input.content
      : Buffer.from(input.content, 'utf8');
    hash.update(`${input.name}\0${content.length}\0`, 'utf8');
    hash.update(content);
  }
  return `sha256:${hash.digest('hex')}`;
}

/** Fingerprints only inputs capable of changing the distributed native addon. */
function computeNativeFingerprint(root = ROOT) {
  const inputs = sourceFiles(root).map(relativePath => ({
    name: relativePath.replaceAll('\\', '/'),
    content: fs.readFileSync(path.join(root, relativePath)),
  }));
  const lock = fs.readFileSync(path.join(root, 'bun.lock'), 'utf8');
  for (const packageName of ['node-addon-api', 'node-gyp']) {
    inputs.push({
      name: `bun.lock:${packageName}`,
      content: lockRecord(lock, packageName),
    });
  }
  return hashNativeInputs(inputs);
}

function validatePrebuildMetadata(metadata, target, fingerprint) {
  return metadata?.schemaVersion === 1 &&
    metadata.platform === target.platform &&
    metadata.architecture === target.arch &&
    metadata.pythonMajorMinor === nativeBuildConfig.pythonMajorMinor &&
    metadata.napi === nativeBuildConfig.napi &&
    metadata.nativeFingerprint === fingerprint &&
    typeof metadata.pythonLibraryName === 'string' &&
    metadata.pythonLibraryName.length > 0;
}

module.exports = {
  computeNativeFingerprint,
  hashNativeInputs,
  nativeBuildConfig,
  nativeFingerprintPaths,
  validatePrebuildMetadata,
};
