import type { Readable, Writable } from 'node:stream';

const PID_LINE = /^#IPC_SERVER_PID#(\d+)#IPC_SERVER_PID#$/u;
const MAX_HANDSHAKE_BYTES = 64 * 1024;

/** Capture the Python PID line before forwarding every other stdout byte. */
export function captureServerPid(
  stream: Readable,
  output: Writable,
  timeoutMs: number,
): Promise<number> {
  stream.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let buffer = '';
    const pendingLines: string[] = [];
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`Python did not report its PID within ${timeoutMs} ms.`)));
    }, timeoutMs);

    const settle = (handler: () => void): void => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      handler();
    };
    const onError = (error: Error): void => settle(() => reject(error));
    const onEnd = (): void => settle(() => reject(new Error(
      `Python stdout ended before the PID handshake.${buffer ? ` Output: ${buffer.trim()}` : ''}`,
    )));
    const onData = (chunk: string): void => {
      buffer += chunk;
      if (Buffer.byteLength(`${pendingLines.join('\n')}\n${buffer}`) > MAX_HANDSHAKE_BYTES) {
        settle(() => reject(new Error('Python PID handshake exceeded 64 KiB.')));
        return;
      }

      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? '';
      pendingLines.push(...lines);
      for (let index = 0; index < pendingLines.length; index += 1) {
        const match = PID_LINE.exec(pendingLines[index] ?? '');
        if (!match) continue;
        const pid = Number(match[1]);
        const before = pendingLines.slice(0, index).join('\n');
        const after = pendingLines.slice(index + 1).join('\n');
        settle(() => {
          const pending = [before, after, buffer].filter(Boolean).join('\n');
          if (pending) output.write(`${pending}\n`);
          stream.pipe(output, { end: false });
          resolve(pid);
        });
        return;
      }
    };

    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}
