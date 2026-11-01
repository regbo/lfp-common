import path from 'path';
import fs from 'fs';
import { spawnSync } from 'child_process';
import type { NativeAddon } from '../types/addon';

export interface NativeAddonBuildOptions {
  projectRoot: string;
  pythonExecutable: string;
  pythonVersion: string;
}

/**
 * Load a compatible packaged prebuild or exact local addon, compiling through
 * the active JavaScript runtime only when neither can be used.
 */
export function loadOrBuildNativeAddon(options: NativeAddonBuildOptions): NativeAddon {
  let initialError: unknown = new Error('Native rebuild explicitly requested.');
  if (process.env['PYNECT_FORCE_BUILD'] !== '1') {
    try {
      return loadMatchingPrebuild(options);
    } catch (error) {
      initialError = error;
    }
    try {
      return loadMatchingLocalAddon(options);
    } catch (error) {
      initialError = new AggregateError([initialError, error], 'No compatible native addon loaded.');
    }
  }

  const packageRoot = path.resolve(__dirname, '..', '..');
  const script = path.join(packageRoot, 'scripts', 'ensure-native.js');
  const result = spawnSync(process.execPath, [script], {
    cwd: packageRoot,
    env: {
      ...process.env,
      PYNECT_PROJECT_ROOT: options.projectRoot,
      PYNECT_PYTHON: options.pythonExecutable,
    },
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(
      `Could not launch the native builder with ${process.execPath}: ${result.error.message}`,
      { cause: initialError },
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Pynect could not load or build its native addon with ${process.execPath}. ` +
      'Install a C++ toolchain or provide a compatible prebuilt addon.',
      { cause: initialError },
    );
  }

  try {
    return loadMatchingLocalAddon(options);
  } catch (error) {
    throw new Error('Pynect built the native addon, but the active runtime could not load it.', {
      cause: error,
    });
  }
}

interface NativeBuildMetadata {
  schemaVersion: number;
  pythonExecutable: string;
  buildType: 'Debug' | 'Release';
}

interface NativePrebuildMetadata {
  schemaVersion: 1;
  platform: NodeJS.Platform;
  architecture: string;
  pythonMajorMinor: string;
  napi: number;
  glibc?: string;
}

function loadMatchingPrebuild(options: NativeAddonBuildOptions): NativeAddon {
  const packageRoot = path.resolve(__dirname, '..', '..');
  const directory = path.join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`);
  const metadataPath = path.join(directory, 'pynect-prebuild.json');
  let metadata: NativePrebuildMetadata;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as NativePrebuildMetadata;
  } catch (error) {
    throw new Error(`Native prebuild metadata is unavailable at ${metadataPath}.`, { cause: error });
  }
  const pythonMajorMinor = options.pythonVersion.split('.').slice(0, 2).join('.');
  if (
    metadata.schemaVersion !== 1 ||
    metadata.platform !== process.platform ||
    metadata.architecture !== process.arch ||
    metadata.pythonMajorMinor !== pythonMajorMinor ||
    metadata.napi > Number(process.versions.napi ?? 0)
  ) {
    throw new Error(
      `Native prebuild does not match ${process.platform}-${process.arch}, ` +
      `Python ${pythonMajorMinor}, N-API ${process.versions.napi ?? 'unknown'}.`,
    );
  }
  if (process.platform === 'linux' && metadata.glibc) {
    const report = process.report?.getReport() as {
      header?: { glibcVersionRuntime?: string };
    } | undefined;
    const runtimeGlibc = report?.header?.glibcVersionRuntime;
    if (!runtimeGlibc || compareVersions(runtimeGlibc, metadata.glibc) < 0) {
      throw new Error(
        `Native prebuild requires glibc ${metadata.glibc}; runtime has ${runtimeGlibc ?? 'unknown'}.`,
      );
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(path.join(directory, 'pynect_addon.node')) as NativeAddon;
}

function loadMatchingLocalAddon(options: NativeAddonBuildOptions): NativeAddon {
  const packageRoot = path.resolve(__dirname, '..', '..');
  const metadataPath = path.join(packageRoot, 'build', 'pynect-python.json');
  let metadata: NativeBuildMetadata;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as NativeBuildMetadata;
  } catch (error) {
    throw new Error(`Native build metadata is unavailable at ${metadataPath}.`, { cause: error });
  }
  if (
    metadata.schemaVersion !== 1 ||
    normalizePath(metadata.pythonExecutable) !== normalizePath(options.pythonExecutable)
  ) {
    throw new Error(
      `Native addon Python ${metadata.pythonExecutable} does not match selected Python ` +
      `${options.pythonExecutable}.`,
    );
  }

  const addonPath = path.join(
    packageRoot,
    'build',
    metadata.buildType === 'Debug' ? 'Debug' : 'Release',
    'pynect_addon.node',
  );
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(addonPath) as NativeAddon;
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
