export interface NativeTarget {
  readonly runner: string;
  readonly platform: 'linux' | 'darwin' | 'win32';
  readonly arch: 'x64' | 'arm64';
  readonly compatibilityPython?: string;
}

export interface NativeBuildConfig {
  readonly schemaVersion: number;
  readonly nodeMajor: number;
  readonly napi: number;
  readonly pythonBuildVersion: string;
  readonly pythonMinimumVersion: string;
  readonly pythonAbi: string;
  readonly windowsArmNodeGyp: string;
  readonly targets: readonly NativeTarget[];
}

export interface NativePrebuildMetadata {
  readonly schemaVersion?: number;
  readonly platform?: string;
  readonly architecture?: string;
  readonly pythonMinimumVersion?: string;
  readonly pythonAbi?: string;
  readonly napi?: number;
  readonly nativeFingerprint?: string;
  readonly pythonLibraryName?: string;
}

export function computeNativeFingerprint(root?: string): string;
export function hashNativeInputs(
  inputs: readonly { readonly name: string; readonly content: string | Buffer }[],
): string;
export const nativeBuildConfig: NativeBuildConfig;
export function nativeFingerprintPaths(root?: string): readonly string[];
export function validatePrebuildMetadata(
  metadata: NativePrebuildMetadata,
  target: NativeTarget,
  fingerprint: string,
): boolean;
