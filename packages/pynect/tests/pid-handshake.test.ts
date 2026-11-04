import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { captureServerPid } from '../src/js/pid-handshake.js';

describe('Python PID handshake', () => {
  test('captures a split sentinel before forwarding the remaining stream', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let forwarded = '';
    output.setEncoding('utf8');
    output.on('data', chunk => { forwarded += chunk; });

    const pidPromise = captureServerPid(input, output, 1_000);
    input.write('startup detail\n#IPC_SERVER_');
    input.write('PID#82471#IPC_SERVER_PID#\nIPC server listening\n');
    const pid = await pidPromise;
    input.write('request log\n');
    await Bun.sleep(10);

    expect(pid).toBe(82471);
    expect(forwarded).toBe('startup detail\nIPC server listening\nrequest log\n');
    expect(forwarded).not.toContain('#IPC_SERVER_PID#');
    input.end();
  });
});
