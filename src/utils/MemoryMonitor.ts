/**
 * pynect - Memory Monitor
 * Tracks Python object references, heap usage, and triggers GC when needed.
 */

import { Logger } from './Logger';
import type { NativeAddon } from '../types/addon';
import { withPynectLock } from './Locking';

export interface MemorySnapshot {
  timestamp: number;
  pythonHeapBytes: number;
  pythonHeapPeakBytes: number;
  trackedObjects: number;
  pendingCallbacks: number;
  nodeHeapUsed: number;
  nodeHeapTotal: number;
  nodeExternal: number;
}

export interface MemoryThresholds {
  /** Trigger GC when Python heap exceeds this (bytes). Default: 1GB */
  gcThreshold: number;
  /** Emit warning when tracked objects exceed this. Default: 10000 */
  objectWarningCount: number;
  /** Emit warning when pending callbacks exceed this. Default: 500 */
  callbackWarningCount: number;
}

export class MemoryMonitor {
  private readonly _logger: Logger;
  private _addon: NativeAddon | null = null;
  private _snapshots: MemorySnapshot[] = [];
  private _maxSnapshots = 100;
  private _monitorInterval: NodeJS.Timeout | null = null;
  private _thresholds: MemoryThresholds;

  constructor(thresholds?: Partial<MemoryThresholds>) {
    this._logger = new Logger('MemoryMonitor');
    this._thresholds = {
      gcThreshold: this._parseBytes('1GB'),
      objectWarningCount: 10000,
      callbackWarningCount: 500,
      ...thresholds,
    };
  }

  attach(addon: NativeAddon): void {
    this._addon = addon;
  }

  startMonitoring(intervalMs = 5000): void {
    if (this._monitorInterval) {return;}
    this._monitorInterval = setInterval(() => {
      this._checkMemory().catch(err => {
        this._logger.error('Memory check failed', err);
      });
    }, intervalMs);

    // Don't keep event loop alive
    if (this._monitorInterval.unref) {
      this._monitorInterval.unref();
    }

    this._logger.debug(`Memory monitoring started (interval: ${intervalMs}ms)`);
  }

  stopMonitoring(): void {
    if (this._monitorInterval) {
      clearInterval(this._monitorInterval);
      this._monitorInterval = null;
      this._logger.debug('Memory monitoring stopped');
    }
  }

  async takeSnapshot(): Promise<MemorySnapshot> {
    const nodeHeap = process.memoryUsage();
    let pythonStats = { pythonHeapBytes: 0, pythonHeapPeakBytes: 0, trackedObjects: 0, pendingCallbacks: 0 };

    if (this._addon) {
      const stats = this._addon.getMemoryStats();
      pythonStats = {
        pythonHeapBytes: stats.pythonHeapBytes,
        pythonHeapPeakBytes: stats.pythonHeapPeakBytes,
        trackedObjects: stats.trackedObjects,
        pendingCallbacks: stats.pendingCallbacks,
      };
    }

    const snapshot: MemorySnapshot = {
      timestamp: Date.now(),
      ...pythonStats,
      nodeHeapUsed: nodeHeap.heapUsed,
      nodeHeapTotal: nodeHeap.heapTotal,
      nodeExternal: nodeHeap.external,
    };

    this._snapshots.push(snapshot);
    if (this._snapshots.length > this._maxSnapshots) {
      this._snapshots.shift();
    }

    return snapshot;
  }

  getSnapshots(): MemorySnapshot[] {
    return [...this._snapshots];
  }

  getLatestSnapshot(): MemorySnapshot | null {
    return this._snapshots[this._snapshots.length - 1] ?? null;
  }

  async forceGC(): Promise<void> {
    await withPynectLock(
      { operation: 'python-gc' },
      async () => {
        if (!this._addon) return;
        this._logger.debug('Running Python garbage collection...');
        await this._addon.collectGarbage();
        this._logger.debug('Python GC completed');
      },
      async () => this._addon !== null,
      {
        key: 'pynect-python-gc',
        name: 'Pynect Python garbage collection',
        namespace: 'pynect',
        scope: 'memory',
      },
    );
  }

  private async _checkMemory(): Promise<void> {
    const snapshot = await this.takeSnapshot();

    // Check Python heap threshold
    if (snapshot.pythonHeapBytes > this._thresholds.gcThreshold) {
      this._logger.warn(
        `Python heap (${this._formatBytes(snapshot.pythonHeapBytes)}) exceeded GC threshold ` +
        `(${this._formatBytes(this._thresholds.gcThreshold)}). Running GC...`
      );
      await this.forceGC();
    }

    // Check tracked objects
    if (snapshot.trackedObjects > this._thresholds.objectWarningCount) {
      this._logger.warn(
        `High Python object count: ${snapshot.trackedObjects} tracked objects`
      );
    }

    // Check pending callbacks
    if (snapshot.pendingCallbacks > this._thresholds.callbackWarningCount) {
      this._logger.warn(
        `High pending callback count: ${snapshot.pendingCallbacks}`
      );
    }
  }

  private _parseBytes(str: string): number {
    const match = str.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/i);
    if (!match) {return 1_073_741_824;} // 1GB default
    const value = parseFloat(match[1]!);
    const unit = (match[2] ?? 'B').toUpperCase();
    const units: Record<string, number> = {
      B: 1,
      KB: 1024,
      MB: 1024 ** 2,
      GB: 1024 ** 3,
      TB: 1024 ** 4,
    };
    return Math.floor(value * (units[unit] ?? 1));
  }

  private _formatBytes(bytes: number): string {
    if (bytes < 1024) {return `${bytes}B`;}
    if (bytes < 1024 ** 2) {return `${(bytes / 1024).toFixed(1)}KB`;}
    if (bytes < 1024 ** 3) {return `${(bytes / 1024 ** 2).toFixed(1)}MB`;}
    return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
  }
}
