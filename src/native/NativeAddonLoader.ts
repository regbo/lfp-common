import path from 'path';
import fs from 'fs';
import { spawnSync } from 'child_process';
import type { NativeAddon } from '../types/addon';

export interface NativeAddonBuildOptions {
  projectRoot: string;
  pythonExecutable: string;
}

/**
 * Load an addon built for the selected Python, compiling it through the active
 * JavaScript runtime when no exact match exists.
 */
export function loadOrBuildNativeAddon(options: NativeAddonBuildOptions): NativeAddon {
  let initialError: unknown = new Error('Native rebuild explicitly requested.');
  if (process.env['PYNECT_FORCE_BUILD'] !== '1') {
    try {
      return loadMatchingLocalAddon(options);
    } catch (error) {
      initialError = error;
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
