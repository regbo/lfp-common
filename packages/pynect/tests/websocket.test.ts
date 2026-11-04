import { describe, expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { connectVenv } from '../src/js/websocket';

const packageRoot = path.resolve(import.meta.dir, '..');

describe('WebSocket transport', () => {
  test('bridges objects, callbacks, and binary values directly to Python', async () => {
    await using server = await startPythonServer({
      fixture: 'tests/fixtures/bridge_fixture.py',
    });
    await using venv = connectVenv({ url: server.url });

    const info = await venv.ready();
    const fixture = await venv.import('fixture');

    expect(info.url).toBe(server.url.href);
    expect(await fixture.add(2, 3)).toBe(5);
    expect(await fixture.call_callback((value: number) => value + 1, 6)).toBe(7);
    expect(await fixture.binary_payload()).toEqual(
      Uint8Array.from([0, 112, 121, 110, 101, 99, 116, 255]),
    );
  }, 120_000);

  test('defaults to loopback, a path, and the Pynect subprotocol', async () => {
    await using server = await startPythonServer({});
    expect(server.url.hostname).toBe('127.0.0.1');
    expect(server.url.pathname).toBe('/pynect');

    const httpUrl = new URL(server.url);
    httpUrl.protocol = 'http:';
    const response = await fetch(httpUrl);
    expect(response.status).toBe(426);

    const wrongPath = new URL('/missing', httpUrl);
    expect((await fetch(wrongPath)).status).toBe(404);
  });

  test('shares one Python server while isolating concurrent client objects', async () => {
    await using server = await startPythonServer({
      fixture: 'tests/fixtures/bridge_fixture.py',
      os: 'os',
    });
    const first = connectVenv({ url: server.url });
    await using second = connectVenv({ url: server.url });
    try {
      const firstOs = await first.import('os');
      const secondOs = await second.import('os');
      expect(await firstOs.getpid()).toBe(server.pid);
      expect(await secondOs.getpid()).toBe(server.pid);

      const firstFixture = await first.import('fixture');
      const secondFixture = await second.import('fixture');
      const firstCounter = await new firstFixture.Counter(1);
      const secondCounter = await new secondFixture.Counter(10);
      expect(await firstCounter.increment()).toBe(2);
      expect(await secondCounter.increment()).toBe(11);

      first.forceClose();
      expect(await secondCounter.increment()).toBe(12);
      expect(isProcessAlive(server.pid)).toBe(true);
    } finally {
      first.forceClose();
    }
  }, 120_000);

  test('denies every module not explicitly exposed by the server', async () => {
    await using server = await startPythonServer({});
    await using venv = connectVenv({ url: server.url });
    await expect(venv.import('os')).rejects.toThrow('is not exposed');
  }, 120_000);

  const signalTest = process.platform === 'win32' ? test.skip : test;
  signalTest('replays one SIGTERM into graceful server shutdown', async () => {
    const server = await startCliServer({ os: 'os' });
    const venv = connectVenv({ url: server.url });
    try {
      const os = await venv.import('os');
      expect(await os.getpid()).toBe(server.pid);

      process.kill(server.pid, 'SIGTERM');
      expect(await server.exited).toBe(0);
      await expect(os.getpid()).rejects.toThrow();
    } finally {
      venv.forceClose();
      server.child.kill();
    }
  }, 120_000);

  test('builds the client without Node runtime imports', async () => {
    const result = await Bun.build({
      entrypoints: [path.resolve(import.meta.dir, '..', 'src', 'js', 'websocket.ts')],
      target: 'browser',
    });

    expect(result.success).toBe(true);
    expect(result.logs).toEqual([]);
    expect(await result.outputs[0]?.text()).not.toContain('node:');
  });

  test('rejects non-WebSocket client URLs', () => {
    expect(() => connectVenv({ url: 'https://example.com/pynect' })).toThrow(
      'must use ws: or wss:',
    );
  });
});

interface ServerProcess extends AsyncDisposable {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<number | null>;
  readonly pid: number;
  readonly url: URL;
}

async function startPythonServer(modules: Record<string, string>): Promise<ServerProcess> {
  return startServerProcess([
    'run',
    '--locked',
    'python',
    'tests/fixtures/websocket_server.py',
    JSON.stringify({ modules }),
  ]);
}

async function startCliServer(modules: Record<string, string>): Promise<ServerProcess> {
  const moduleArgs = Object.entries(modules)
    .flatMap(([name, target]) => [`--modules.${name}`, target]);
  return startServerProcess(['run', '--locked', 'pynect-server', ...moduleArgs], false);
}

async function startServerProcess(
  args: readonly string[],
  closeStdin = true,
): Promise<ServerProcess> {
  const child = spawn('uv', [...args], {
    cwd: packageRoot,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const metadata = await readStartup(child);
  const pid = metadata.pid ?? child.pid;
  if (typeof pid !== 'number') throw new TypeError('Pynect server returned no PID.');
  return {
    child,
    exited,
    pid,
    url: new URL(metadata.url),
    async [Symbol.asyncDispose]() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (closeStdin) child.stdin.end();
      else child.kill();
      await Promise.race([exited, Bun.sleep(5_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  };
}

function readStartup(
  child: ChildProcessWithoutNullStreams,
): Promise<{ readonly pid?: number; readonly url: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(
      () => reject(new Error(`Pynect server startup timed out: ${stderr}`)),
      30_000,
    );
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => stderr += chunk);
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const line = stdout.split(/\r?\n/u).find(value => value.startsWith('{'));
      if (!line) return;
      clearTimeout(timeout);
      try {
        const value = JSON.parse(line) as { pid?: unknown; url?: unknown };
        if (typeof value.url !== 'string') throw new TypeError('Missing server URL.');
        if (value.pid !== undefined && typeof value.pid !== 'number') {
          throw new TypeError('Invalid server PID.');
        }
        resolve({ pid: value.pid, url: value.url });
      } catch (error) {
        reject(error);
      }
    });
    child.once('error', reject);
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Pynect server exited during startup (${code}): ${stderr}`));
    });
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
