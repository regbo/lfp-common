import { randomBytes } from 'node:crypto';
import { chmod, rm } from 'node:fs/promises';
import net, { type Server, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';

export class LocalIpcServer {
  readonly endpoint: string;
  readonly #server: Server;
  readonly #connection: Promise<Socket>;
  #resolveConnection!: (socket: Socket) => void;
  #rejectConnection!: (error: Error) => void;
  #settled = false;

  private constructor(endpoint: string) {
    this.endpoint = endpoint;
    this.#server = net.createServer();
    this.#connection = new Promise<Socket>((resolve, reject) => {
      this.#resolveConnection = resolve;
      this.#rejectConnection = reject;
    });
    this.#server.once('connection', socket => {
      if (this.#settled) {
        socket.destroy();
        return;
      }
      this.#settled = true;
      this.#resolveConnection(socket);
      this.#server.close();
    });
    this.#server.once('error', error => {
      if (!this.#settled) {
        this.#settled = true;
        this.#rejectConnection(error);
      }
    });
    this.#server.maxConnections = 1;
  }

  static async listen(): Promise<LocalIpcServer> {
    const endpoint = createEndpoint();
    const transport = new LocalIpcServer(endpoint);
    await new Promise<void>((resolve, reject) => {
      transport.#server.once('error', reject);
      transport.#server.listen(endpoint, () => {
        transport.#server.off('error', reject);
        resolve();
      });
    });
    if (process.platform !== 'win32') await chmod(endpoint, 0o600);
    return transport;
  }

  waitForConnection(timeoutMs: number): Promise<Socket> {
    return withTimeout(this.#connection, timeoutMs, 'Python worker did not connect in time.');
  }

  unref(): void {
    this.#server.unref();
  }

  async close(): Promise<void> {
    await new Promise<void>(resolve => {
      if (!this.#server.listening) {
        resolve();
        return;
      }
      this.#server.close(() => resolve());
    });
    if (process.platform !== 'win32') {
      await rm(this.endpoint, { force: true }).catch(() => undefined);
    }
  }
}

function createEndpoint(): string {
  const suffix = `${process.pid}-${randomBytes(12).toString('hex')}`;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\pynect-${suffix}`
    : path.join(os.tmpdir(), `pynect-${suffix}.sock`);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
