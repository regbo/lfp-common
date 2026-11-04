import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const helper = path.join(import.meta.dir, 'fixtures', 'shutdown-child.ts');
const terminationSignals = process.platform === 'win32'
  ? ['SIGHUP', 'SIGINT', 'SIGTERM', 'SIGBREAK'] as const
  : ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM'] as const;

describe('process shutdown', () => {
  test('handles one SIGTERM received before the Python handshake', async () => {
    const result = await runHelper('startup-signal', 'SIGTERM');

    expect(result.code).toBe(143);
    expect(result.signal).toBeNull();
    expect(result.pythonPid).toBeUndefined();
  }, 120_000);

  test('waits for Python during natural host exit', async () => {
    const result = await runHelper('natural');

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(await waitForProcessExit(requirePythonPid(result))).toBe(true);
  }, 120_000);

  for (const signal of terminationSignals) {
    test(`forwards ${signal} and waits for Python before exiting`, async () => {
      const result = await runHelper('signal', signal);

      expect(result.code).toBe(128 + (os.constants.signals[signal] ?? 1));
      expect(result.signal).toBeNull();
      expect(await waitForProcessExit(requirePythonPid(result))).toBe(true);
    }, 120_000);
  }
});

interface HelperResult {
  readonly code: number | null;
  readonly pythonPid?: number;
  readonly signal: NodeJS.Signals | null;
}

function runHelper(
  mode: 'natural' | 'signal' | 'startup-signal',
  signal?: NodeJS.Signals,
): Promise<HelperResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, mode, ...(signal ? [signal] : [])], {
      cwd: path.resolve(import.meta.dir, '..'),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => stdout += chunk);
    child.stderr.on('data', (chunk: string) => stderr += chunk);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      try {
        const line = stdout.trim().split(/\r?\n/u).find(value => value.startsWith('{'));
        if (!line) throw new Error(`Shutdown helper returned no metadata: ${stderr.trim()}`);
        const value = JSON.parse(line) as { pythonPid?: unknown; startup?: unknown };
        if (typeof value.pythonPid !== 'number' && value.startup !== true) {
          throw new TypeError('Shutdown helper returned invalid process metadata.');
        }
        resolve({
          code,
          pythonPid: typeof value.pythonPid === 'number' ? value.pythonPid : undefined,
          signal,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function requirePythonPid(result: HelperResult): number {
  if (result.pythonPid === undefined) throw new Error('Shutdown helper returned no Python PID.');
  return result.pythonPid;
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await Bun.sleep(25);
  }
  return !isProcessAlive(pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
