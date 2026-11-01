import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import type { NativeAddon } from '../types/addon';

export interface NativeAddonBuildOptions {
  projectRoot: string;
  pythonExecutable: string;
  pythonLibrary: string;
  pythonVersion: string;
}

/**
 * Load a compatible packaged prebuild or exact local addon, compiling through
 * the active JavaScript runtime only when neither can be used.
 */
export function loadOrBuildNativeAddon(options: NativeAddonBuildOptions): NativeAddon {
  let initialError: unknown = new Error('Native rebuild explicitly requested.');
  if (process.env['PYNECT_FORCE_BUILD'] !== '1') {
    if (process.env['PYNECT_PREFER_LOCAL'] === '1') {
      try {
        return loadMatchingLocalAddon(options);
      } catch (error) {
        initialError = error;
      }
    }
    try {
      return loadMatchingPrebuild(options);
    } catch (error) {
      initialError = error;
    }
    if (process.env['PYNECT_PREFER_LOCAL'] !== '1') {
      try {
        return loadMatchingLocalAddon(options);
      } catch (error) {
        initialError = new AggregateError([initialError, error], 'No compatible native addon loaded.');
      }
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
  schemaVersion: 2;
  platform: NodeJS.Platform;
  architecture: string;
  pythonMinimumVersion: string;
  pythonAbi: string;
  napi: number;
  glibc?: string;
  pythonLibraryName: string;
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
  const pythonVersion = majorMinor(options.pythonVersion);
  const minimumVersion = typeof metadata.pythonMinimumVersion === 'string'
    ? majorMinor(metadata.pythonMinimumVersion)
    : [Number.POSITIVE_INFINITY, 0] as const;
  if (
    metadata.schemaVersion !== 2 ||
    metadata.platform !== process.platform ||
    metadata.architecture !== process.arch ||
    metadata.pythonAbi !== 'cp310-abi3' ||
    pythonVersion[0] !== 3 ||
    compareMajorMinor(pythonVersion, minimumVersion) < 0 ||
    metadata.napi > Number(process.versions.napi ?? 0)
  ) {
    throw new Error(
      `Native prebuild does not match ${process.platform}-${process.arch}, ` +
      `Python ${options.pythonVersion}, N-API ${process.versions.napi ?? 'unknown'}.`,
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
  const packagedAddon = path.join(directory, 'pynect_addon.node');
  const addon = process.platform === 'win32'
    ? packagedAddon
    : materializePortablePrebuild(packagedAddon, metadata, options);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(addon) as NativeAddon;
}

function materializePortablePrebuild(
  packagedAddon: string,
  metadata: NativePrebuildMetadata,
  options: NativeAddonBuildOptions,
): string {
  const identity = createHash('sha256')
    .update(path.resolve(options.pythonLibrary))
    .digest('hex')
    .slice(0, 12);
  const directory = path.join(
    options.projectRoot,
    'node_modules',
    '.pynect',
    'native',
    `${process.platform}-${process.arch}-${metadata.pythonAbi}-${identity}`,
  );
  const addon = path.join(directory, 'pynect_addon.node');
  const library = path.join(directory, metadata.pythonLibraryName);
  fs.mkdirSync(directory, { recursive: true });
  publishFile(packagedAddon, addon);
  publishSymlink(options.pythonLibrary, library);
  return addon;
}

function publishFile(source: string, destination: string): void {
  if (fs.existsSync(destination)) return;
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    fs.renameSync(temporary, destination);
  } catch (error) {
    if (!fs.existsSync(destination)) throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function publishSymlink(source: string, destination: string): void {
  if (fs.existsSync(destination)) return;
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    fs.symlinkSync(path.resolve(source), temporary, 'file');
    fs.renameSync(temporary, destination);
  } catch (error) {
    if (!fs.existsSync(destination)) throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
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

function majorMinor(version: string): readonly [number, number] {
  const match = version.match(/^(\d+)\.(\d+)/u);
  if (!match) throw new Error(`Invalid Python version: ${version}`);
  return [Number(match[1]), Number(match[2])];
}

function compareMajorMinor(
  left: readonly [number, number],
  right: readonly [number, number],
): number {
  return left[0] - right[0] || left[1] - right[1];
}
