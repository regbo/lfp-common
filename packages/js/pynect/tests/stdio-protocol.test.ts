import { describe, expect, test } from 'bun:test';
import { PassThrough, Writable } from 'node:stream';
import {
  createStdioPrefix,
  encodeStdioRecord,
  MAX_STDIO_RECORD_BYTES,
  parseWorkerStdioEvent,
  StdioOutputParser,
  StdioRecordWriter,
} from '../src/stdio-protocol.js';

describe('stdio protocol', () => {
  test('parses split and coalesced records while preserving ordinary output', () => {
    const prefix = createStdioPrefix();
    const events: unknown[] = [];
    const output: Buffer[] = [];
    const errors: Error[] = [];
    const parser = new StdioOutputParser({
      prefix,
      onEvent: event => { events.push(event); },
      onOutput: chunk => { output.push(chunk); },
      onProtocolError: error => { errors.push(error); },
    });
    const first = encodeStdioRecord(prefix, { type: 'hello', protocol: 1, pid: 123 });
    const second = encodeStdioRecord(prefix, { type: 'frame', data: '{"action":"pong"}' });

    for (const byte of first) parser.push(Buffer.from([byte]));
    parser.push(Buffer.concat([Buffer.from('before\r\n\n'), second, Buffer.from('after\n')]));
    parser.finish();

    expect(events).toEqual([
      { type: 'hello', protocol: 1, pid: 123 },
      { type: 'frame', data: '{"action":"pong"}' },
    ]);
    expect(Buffer.concat(output).toString()).toBe('before\r\n\nafter\n');
    expect(errors).toEqual([]);
  });

  test('forwards a partial ordinary line and rejects a partial protocol record at EOF', () => {
    const prefix = createStdioPrefix();
    const ordinary: Buffer[] = [];
    const ordinaryErrors: Error[] = [];
    const ordinaryParser = new StdioOutputParser({
      prefix,
      onEvent: () => undefined,
      onOutput: chunk => { ordinary.push(chunk); },
      onProtocolError: error => { ordinaryErrors.push(error); },
    });
    ordinaryParser.push('partial output');
    ordinaryParser.finish();
    expect(Buffer.concat(ordinary).toString()).toBe('partial output');
    expect(ordinaryErrors).toEqual([]);

    const protocolErrors: Error[] = [];
    const protocolParser = new StdioOutputParser({
      prefix,
      onEvent: () => undefined,
      onOutput: () => undefined,
      onProtocolError: error => { protocolErrors.push(error); },
    });
    protocolParser.push(`${prefix}12:{"type"`);
    protocolParser.finish();
    expect(protocolErrors[0]?.message).toContain('ended during');
  });

  test('finds records after partial application output without inserting a newline', () => {
    const prefix = createStdioPrefix();
    const otherPrefix = createStdioPrefix();
    const output: Buffer[] = [];
    const events: unknown[] = [];
    const parser = new StdioOutputParser({
      prefix,
      onEvent: event => { events.push(event); },
      onOutput: chunk => { output.push(chunk); },
      onProtocolError: error => { throw error; },
    });
    parser.push('ordinary without newline');
    parser.push(encodeStdioRecord(prefix, { type: 'bye' }));
    parser.push(`${otherPrefix}ordinary`);
    parser.finish();

    expect(events).toEqual([{ type: 'bye' }]);
    expect(Buffer.concat(output).toString()).toBe(`ordinary without newline${otherPrefix}ordinary`);
  });

  test('rejects malformed JSON, unknown events, and unsupported versions', () => {
    const prefix = createStdioPrefix();
    const errors: Error[] = [];
    const parser = new StdioOutputParser({
      prefix,
      onEvent: () => undefined,
      onOutput: () => undefined,
      onProtocolError: error => { errors.push(error); },
    });
    parser.push(`${prefix}6:{nope}`);
    expect(errors[0]?.message).toContain('malformed');

    const lengthErrors: Error[] = [];
    const lengthParser = new StdioOutputParser({
      prefix,
      onEvent: () => undefined,
      onOutput: () => undefined,
      onProtocolError: error => { lengthErrors.push(error); },
    });
    lengthParser.push(`${prefix}${MAX_STDIO_RECORD_BYTES + 1}:`);
    expect(lengthErrors[0]?.message).toContain('out-of-range');
    expect(() => parseWorkerStdioEvent({ type: 'mystery' })).toThrow('Unknown');
    expect(() => parseWorkerStdioEvent({ type: 'hello', protocol: 2, pid: 1 })).toThrow(
      'Unsupported',
    );
  });

  test('serializes stdin writes in order', async () => {
    const prefix = createStdioPrefix();
    const chunks: Buffer[] = [];
    const output = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        setTimeout(() => {
          chunks.push(Buffer.from(chunk));
          callback();
        }, 1);
      },
    });
    const writer = new StdioRecordWriter(output, prefix);
    await Promise.all([
      writer.write({ type: 'frame', data: 'first' }),
      writer.write({ type: 'frame', data: 'second' }),
    ]);
    await writer.end();

    expect(Buffer.concat(chunks)).toEqual(Buffer.concat([
      encodeStdioRecord(prefix, { type: 'frame', data: 'first' }),
      encodeStdioRecord(prefix, { type: 'frame', data: 'second' }),
    ]));
  });

  test('compact records round-trip through a real stream', async () => {
    const prefix = createStdioPrefix();
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', chunk => { chunks.push(chunk); });
    const writer = new StdioRecordWriter(stream, prefix);
    await writer.write({ type: 'shutdown' });
    await writer.end();
    expect(Buffer.compare(
      Buffer.concat(chunks),
      encodeStdioRecord(prefix, { type: 'shutdown' }),
    )).toBe(0);
  });
});
