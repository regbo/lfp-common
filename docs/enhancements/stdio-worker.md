# Owned stdio worker transport

Status: implemented

This enhancement replaces Pynect's parent-owned Unix-socket and Windows
named-pipe transport with an owned Python subprocess communicating over stdin
and stdout. It covers the transport protocol, process lifecycle, output
forwarding, migration, verification, and benchmarks.

## Decisions

- One Bun/Node process owns one Python worker process.
- The worker is not discoverable or reusable by another parent.
- stdin carries framed requests from Bun to Python.
- stdout multiplexes framed responses with ordinary Python output.
- stderr is forwarded immediately and unchanged.
- The first framed response identifies the real Python PID.
- Reusable services continue to use HTTP/WebSocket.
- Shared endpoint discovery, Unix sockets, Windows named pipes, and stale-socket
  cleanup are removed after migration.
- The transport accepts an already resolved Python executable string. Runtime
  discovery is a separate concern.
- Chanx frames remain opaque to the stdio layer; this transport does not create
  another request-dispatch protocol.

## Goals

1. Reduce local round-trip overhead.
2. Remove endpoint naming, collision, discovery, and cleanup logic.
3. Preserve Python stdout and stderr for the caller.
4. Report the Python PID before application imports or worker setup.
5. Handle malformed frames, process exit, EOF, shutdown, and backpressure
   deterministically.
6. Continue presenting Chanx with a `WebSocketLike` client transport.

## Non-goals

- A reusable local daemon.
- Cross-process worker discovery.
- HTTP or WebSocket server changes.
- Python interpreter discovery inside the transport.
- An HTTP benchmark.

## Proof-of-concept results

The raw prefixed-stdio POC used a literal Python executable path on Windows and
started timing immediately before `spawn(pythonPath)`. Seven fresh processes
each ran 100 warmups and 10,000 measured pings.

| Measurement | Result |
| --- | ---: |
| Direct `python.exe` spawn to PID hello | 145.9 ms |
| First ping/pong after hello | 0.366 ms |
| Spawn to first pong | 146.2 ms |
| Warm ping/pong | 0.053 ms |
| Warm p95 | 0.090 ms |
| Sequential pings per second | 16,795 |

These figures measure JSON framing and process pipes, not application import or
Chanx dispatch. They are a transport baseline rather than a production
performance guarantee.

## Public JavaScript API

Replace the local-server API with an owned-worker API:

```ts
await using worker = await startWorker({
  python: 'C:\\path\\to\\python.exe',
  root: '../python',
});

const client = createPynectClient(worker.clientOptions);
```

The worker object exposes:

- `clientOptions`: Chanx options backed by the stdio `WebSocketLike` adapter;
- `pid`: the real Python PID after the hello frame;
- `exited`: the child exit promise;
- `wait()`: wait for child termination;
- `close()`: idempotent graceful shutdown;
- `Symbol.asyncDispose`: delegates to `close()`.

`startWorker()` always creates a child owned by the current process. There is no
`ensureWorker()` or reuse mode. A caller that needs an independently managed
service uses the remote HTTP/WebSocket client.

The low-level transport requires a concrete `python` path. A higher-level
launcher may resolve one before calling it, but no resolution work belongs in
the transport or its cold-start measurement.

## Protocol

### Prefix

The parent generates a random 96-bit base64url token for every child and passes
the complete prefix through the environment:

```text
PYNECT_STDIO_PREFIX=@pynect:<token> 
```

The token is random rather than PID-derived. Separate child pipes already
isolate processes; the token prevents ordinary output from being mistaken for
protocol traffic.

### Records

stdin and stdout protocol records use the random prefix, an ASCII decimal JSON
byte length, a colon, and exactly that many UTF-8 JSON bytes:

```text
@pynect:<token> <length>:{"type":"hello","protocol":1,"pid":1234}
@pynect:<token> <length>:{"type":"open","path":"/ws/models","query":""}
@pynect:<token> <length>:{"type":"frame","data":"{...}"}
@pynect:<token> <length>:{"type":"close","code":1000,"reason":""}
```

Records have no delimiter and make no assumption about line boundaries. The
implementation caps an individual record at 16 MiB.

The v1 event set is deliberately small:

- `hello`: protocol version and real Python PID;
- `open`: virtual WebSocket path, query, headers, and subprotocols;
- `frame`: one opaque Chanx text frame;
- `close`: virtual connection closure;
- `error`: fatal transport failure;
- `shutdown`: parent requests worker termination;
- `bye`: worker acknowledges graceful shutdown.

Protocol invariants:

1. The first matching stdout record must be `hello`.
2. `hello` is written and flushed before importing the application or worker
   implementation.
3. Every later matching marker and length is parsed as a protocol event.
4. An invalid length or JSON payload after the exact marker is a fatal protocol
   error.
5. Unknown event types or unsupported protocol versions are fatal.
6. Chanx message JSON remains a string inside `frame`; the transport does not
   inspect actions, refs, payloads, completions, or errors.
7. Python serializes complete protocol writes through one queue or lock.
8. Bun preserves record ordering and honors writable backpressure.

### Ordinary stdout

The Bun parser stays attached to Python stdout for the child's entire lifetime.
It searches for the random marker at any byte offset, consumes the following
length-framed record, and writes every nonprotocol byte to the caller-provided
stdout sink unchanged. Partial lines, CRLF, blank lines, binary writes, and
trailing ordinary bytes are preserved without inserting a newline. A marker or
payload truncated at EOF is a fatal protocol error.

### Stderr

Pipe Python stderr to the configured stderr sink immediately after spawning.
PID detection and stdout parsing must not delay, buffer, redirect, or swallow
stderr.

## Python worker

Keep the Python side small and stdlib-only at the transport layer:

```text
pynect/worker/
├── protocol.py
└── stdio.py
```

`protocol.py` owns:

- typed event validation;
- prefix encoding;
- compact JSON serialization;
- the single-writer lock or queue.

`stdio.py` owns:

- the early PID hello;
- stdin reading;
- worker connection startup;
- forwarding opaque frames;
- stdin EOF and explicit shutdown;
- cancellation of active connection tasks during process exit.

The executable launcher emits `hello` before importing the application-facing
worker module. It then imports and runs the stdio worker. `PYTHONUNBUFFERED=1`
remains set, but every protocol write also flushes explicitly.

## Bun/Node transport

Centralize the JavaScript implementation in two discoverable modules:

```text
src/
├── stdio-protocol.ts
└── worker.ts
```

`stdio-protocol.ts` owns:

- the random prefix;
- incremental stdout parsing;
- protocol event validation;
- pass-through output;
- stdin record serialization.

`worker.ts` owns:

- spawning the resolved Python path;
- the Chanx `WebSocketLike` adapter;
- PID readiness;
- process-tree signal forwarding;
- graceful and forced termination;
- the public worker lifecycle.

Reuse the existing owned-process-tree utility. Do not duplicate signal or
process termination logic in the protocol parser.

## Lifecycle and failure handling

### Startup

1. Validate the supplied Python path and project configuration.
2. Generate the random prefix.
3. Spawn Python with stdin, stdout, and stderr piped.
4. Pipe stderr immediately.
5. Parse stdout until `hello` supplies the Python PID.
6. Create the virtual connection and mark the `WebSocketLike` transport open.
7. Reject startup on timeout, invalid hello, child error, or early exit.

### Normal shutdown

1. Stop accepting new sends.
2. Send `close` for the virtual connection.
3. Send `shutdown` and end stdin.
4. Wait for `bye` and process exit.
5. Escalate through the existing process-tree termination policy on timeout.
6. Resolve concurrent `close()` calls through one shared promise.

stdin EOF is also a graceful shutdown request. The worker must not rely only on
parent-PID polling.

### Errors and exit

- Malformed protocol output rejects startup or all pending operations.
- stdout EOF closes the `WebSocketLike` adapter.
- Child exit rejects unresolved operations with the exit code or signal.
- A stdin write failure closes the transport and terminates the worker.
- A pass-through stdout sink error must not be mistaken for a Python protocol
  error; report both causes when necessary.
- Retain already received stdout and stderr diagnostics in startup errors.
- Remove every stream, process, and signal listener during disposal.

## Migration

The socket transport is removed rather than retained for a compatibility
window. `startWorker()` is the only owned local transport. Python Unix-socket
and Windows named-pipe serving, stale-socket cleanup, parent-PID polling,
JavaScript `net.Socket` adaptation, `startIpcServer()`, `ensureIpcServer()`,
endpoint discovery, and pipe-name helpers are gone. Remote HTTP/WebSocket
clients remain unchanged.

## Verification

### Protocol parser

Test:

- one marker, length, and payload split across many chunks;
- many records in one chunk;
- records adjacent to partial, CRLF, blank, and binary ordinary output;
- ordinary stdout before and after hello;
- a partial ordinary line at EOF;
- a partial marker, length, or payload at EOF;
- invalid JSON after the exact prefix;
- invalid and oversized record lengths;
- duplicate hello;
- unsupported protocol version;
- unknown event type;
- ordinary output that resembles another process's prefix;
- slow stdout sinks and stdin backpressure.

### Process lifecycle

Test:

- PID hello precedes application imports;
- stderr is visible before and after hello;
- Python exits before hello;
- Python exits after opening;
- Bun ends stdin;
- Bun receives a termination signal;
- graceful close and forced-close timeout;
- concurrent idempotent close calls;
- listener and handle cleanup;
- Windows and Linux behavior.

### Integration

- Run a real generated client over the stdio `WebSocketLike` adapter.
- Correlate concurrent Chanx requests over the single physical stdio transport.
- Confirm remote WebSocket clients remain unchanged.
- Confirm the worker is inaccessible from another Bun/Node process.

## Benchmarks

Keep two benchmark modes:

### Raw transport

- Use a literal Python executable path.
- Do not call Pyfig or uv in the measured process.
- Start the clock immediately before direct Python spawn.
- Emit the first Python record as PID `hello`.
- Measure spawn to hello, hello to first pong, spawn to first pong, warm
  p50/p95/p99, and sequential pings per second.

Run with:

```powershell
bun run benchmark:stdio
```

### Application comparison

- Import the same Python operation before starting warm measurements.
- Compare direct Python calls with calls through stdio.
- Measure the same payload and serialization behavior on both paths.
- Report application import separately from transport startup.
- Do not include HTTP.

Run the checked-in comparison directly with:

```powershell
bun packages/js/pynect/scripts/benchmark-application.ts
```

Benchmark output must state its exact timing boundary. Do not combine Bun module
loading, interpreter discovery, application import, and transport time into one
number.

## Implementation sequence

1. Extract the POC marker/length parser and serializer into focused protocol
   modules.
2. Add protocol unit tests before connecting Chanx.
3. Implement the Python stdio loop and early PID hello.
4. Implement the Bun worker lifecycle and `WebSocketLike` adapter.
5. Run a real generated client through stdio.
6. Switch examples and local integration tests to `startWorker()`.
7. Keep the raw transport benchmark on the production framing format.
8. Remove the named/Unix-socket API and implementation.
9. Update the utility catalogs and public local-worker documentation.

## Release instructions

For a release containing the transport:

1. run targeted parser and lifecycle tests during implementation;
2. run the complete Bun/TypeScript and uv/Python verification suites;
3. run Windows and Linux stdio integration tests;
4. build and install-test the npm archive and Python wheel;
5. commit only the stdio transport and its migration documentation;
6. push the commit;
7. run `bun run release` after the push;
8. do not use a release dry run;
9. verify the tag, package registries, and release artifacts.

## Completion criteria

The stdio enhancement is complete when:

- `startWorker()` launches a resolved Python path without a socket endpoint;
- the first framed record reports the real Python PID;
- ordinary stdout and all stderr remain visible;
- Chanx clients operate through the stdio `WebSocketLike` adapter;
- malformed output, EOF, process failure, and shutdown are deterministic;
- listener, handle, and child-process cleanup is verified;
- raw and application benchmarks state reproducible timing boundaries;
- owned local calls use stdio;
- reusable services continue to use HTTP/WebSocket;
- named-pipe and Unix-socket local IPC are absent.
