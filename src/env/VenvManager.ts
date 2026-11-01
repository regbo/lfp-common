import fs from 'fs';
import path from 'path';
import type { VirtualenvConfig } from '../types/config';
import { Logger } from '../utils/Logger';
import { PackageInstaller } from './PackageInstaller';
import {
  ensurePynectEnvironment,
  pynectProjectRoot,
  type SelectedPython,
} from './PyfigAdapter';

const logger = new Logger('VenvManager');
const STATE_FILENAME = '.pynect-venv-state.json';

export interface VenvState {
  createdAt: number;
  pythonVersion: string;
  installedPackages: string[];
  lastInstallAt: number;
}

export interface VenvSetupResult {
  pythonExecutable: string;
  /** The package-manager executable selected by Pyfig (uv or the venv Python). */
  pipExecutable: string;
  created: boolean;
  packagesInstalled: boolean;
}

export interface VenvManagerOptions {
  virtualenv: VirtualenvConfig;
  basePython?: string;
  installTimeout?: number;
  /** Retained for API compatibility; Pyfig decides whether pip needs bootstrapping. */
  skipPipUpgrade?: boolean;
}

/**
 * Compatibility facade for the historical VenvManager API.
 * Environment creation and package execution are delegated to Pyfig so Pynect
 * cannot drift onto a different interpreter or standalone pip executable.
 */
export class VenvManager {
  private readonly config: VirtualenvConfig & {
    packages: string[];
    autoInstall: boolean;
    pipArgs: string[];
  };
  private readonly basePython: string;
  private readonly installTimeout: number;
  private readonly projectRoot: string;
  private readonly venvPath: string;
  private readonly statePath: string;
  private selectedPython?: SelectedPython;

  constructor(options: VenvManagerOptions) {
    this.config = {
      ...options.virtualenv,
      packages: options.virtualenv.packages ?? [],
      autoInstall: options.virtualenv.autoInstall ?? false,
      pipArgs: options.virtualenv.pipArgs ?? [],
    };
    this.basePython = options.basePython ?? '';
    this.installTimeout = options.installTimeout ?? 300_000;

    const configuredPath = this.config.path ? path.resolve(this.config.path) : null;
    if (configuredPath && path.basename(configuredPath).toLowerCase() !== '.venv') {
      throw new Error(
        `Pynect only supports the repository-root .venv; received ${configuredPath}.`,
      );
    }
    this.projectRoot = configuredPath ? path.dirname(configuredPath) : pynectProjectRoot();
    this.venvPath = path.join(this.projectRoot, '.venv');
    this.statePath = path.join(this.venvPath, STATE_FILENAME);
  }

  async setup(): Promise<VenvSetupResult> {
    const existed = this.isValid();
    const { environment } = await ensurePynectEnvironment({
      projectRoot: this.projectRoot,
      pythonPath: this.basePython,
    });
    this.selectedPython = environment.python;
    this.assertSelectedEnvironment(environment.python);

    let packagesInstalled = false;
    if (this.config.autoInstall && this.config.packages.length > 0) {
      const installer = this.installer();
      const missing = installer.getMissing(this.config.packages);
      if (missing.length > 0) {
        const result = await installer.install(missing);
        if (!result.success) {
          throw new PackageInstallError(
            missing,
            result.failed.map(item => `${item.spec}: ${item.error}`).join('; '),
          );
        }
        packagesInstalled = true;
      }
      this.updateState(installer);
    }

    const manager = environment.packageManager as { executable: string };
    logger.info(`VenvManager: ready: ${environment.python.executable}`);
    return {
      pythonExecutable: environment.python.executable,
      pipExecutable: manager.executable,
      created: !existed,
      packagesInstalled,
    };
  }

  async install(packages: string[]): Promise<void> {
    const installer = this.installer();
    const result = await installer.install(packages);
    if (!result.success) {
      throw new PackageInstallError(
        packages,
        result.failed.map(item => `${item.spec}: ${item.error}`).join('; '),
      );
    }
    this.updateState(installer);
  }

  getMissingPackages(): string[] {
    return this.installer().getMissing(this.config.packages);
  }

  get pythonExecutable(): string {
    return this.selectedPython?.executable ?? venvPython(this.venvPath);
  }

  isValid(): boolean {
    return fs.existsSync(path.join(this.venvPath, 'pyvenv.cfg')) &&
      fs.existsSync(venvPython(this.venvPath));
  }

  destroy(): void {
    if (fs.existsSync(this.venvPath)) {
      fs.rmSync(this.venvPath, { recursive: true, force: true });
      logger.info(`VenvManager: destroyed venv at ${this.venvPath}`);
    }
  }

  listInstalled(): string[] {
    return this.loadState()?.installedPackages ?? [];
  }

  private installer(): PackageInstaller {
    if (!this.isValid()) {
      throw new Error(`VenvManager: venv does not exist at ${this.venvPath}`);
    }
    return new PackageInstaller({
      pythonExecutable: this.pythonExecutable,
      cwd: this.projectRoot,
      indexUrl: this.config.pipIndexUrl,
      timeoutMs: this.installTimeout,
    });
  }

  private assertSelectedEnvironment(python: SelectedPython): void {
    if (!python.virtualEnvironment || !pathsEqual(python.virtualEnvironment, this.venvPath)) {
      throw new Error(
        `Pyfig selected ${python.virtualEnvironment ?? python.executable}; expected ${this.venvPath}.`,
      );
    }
  }

  private updateState(installer: PackageInstaller): void {
    const state: VenvState = {
      createdAt: this.loadState()?.createdAt ?? Date.now(),
      pythonVersion: this.selectedPython?.version ?? 'unknown',
      installedPackages: installer.listInstalled().map(item => `${item.name}==${item.version}`),
      lastInstallAt: Date.now(),
    };
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf8');
  }

  private loadState(): VenvState | null {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as VenvState;
    } catch {
      return null;
    }
  }
}

function venvPython(venvPath: string): string {
  return path.join(
    venvPath,
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python',
  );
}

function pathsEqual(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

export class VenvCreationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VenvCreationError';
  }
}

export class PackageInstallError extends Error {
  readonly packages: string[];

  constructor(packages: string[], detail: string) {
    super(`Failed to install packages [${packages.join(', ')}]: ${detail}`);
    this.name = 'PackageInstallError';
    this.packages = packages;
  }
}
