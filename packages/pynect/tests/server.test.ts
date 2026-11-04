import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { canConnectIpc } from '../src/js/ipc.js';
import { startIpcServer } from '../src/js/server.js';

describe('Pyfig IPC server', () => {
  test('captures the Python PID, forwards later output, and disposes the server', async () => {
    const stdout = new PassThrough();
    let output = '';
    stdout.setEncoding('utf8');
    stdout.on('data', chunk => { output += chunk; });
    const name = `pynect-integration-${process.pid}-${Date.now()}`;
    const server = await startIpcServer({
      root: path.resolve(import.meta.dir, '..'),
      app: 'tests.fixtures.catalog:app',
      name,
      stdout,
      startupTimeoutMs: 30_000,
    });

    expect(server.owned).toBe(true);
    expect(server.pid).toBeNumber();
    expect(server.pid && isProcessAlive(server.pid)).toBe(true);
    expect(await canConnectIpc(server.path)).toBe(true);
    expect(output).toContain('IPC server listening at');
    expect(output).not.toContain('#IPC_SERVER_PID#');

    const pid = server.pid!;
    await server.close();
    expect(isProcessAlive(pid)).toBe(false);
  }, 60_000);
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
