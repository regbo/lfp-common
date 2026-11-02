# Pynect

Pynect gives Node.js and Bun a lazy Python environment with asynchronous proxies for Python modules, functions, classes, objects, callbacks, and iterators.

Each Venv runs in its own Python process. Separate Venvs can therefore use incompatible Python projects and dependencies in the same JavaScript application. Pynect communicates over a Unix-domain socket on Linux and macOS and a named pipe on Windows.

## Install

```sh
bun add pynect
```

Python and uv do not need to be preinstalled. Pyfig selects an existing compatible setup when possible and can install them when necessary.

## Use

```ts
import { createVenv } from 'pynect';

await using python = createVenv();
const math = await python.import('math');

console.log(await math.sqrt(81));
```

`createVenv()` is synchronous and lazy. It does not inspect Python, run uv, create a socket, or start a process until `import()` or `ready()` is called. Closing an unused Venv starts nothing.

The default project behavior matches `uv run`: uv discovers a project from the working directory and its parents. Select a project explicitly or disable project discovery when needed:

```ts
const project = createVenv({ project: './python' });
const isolated = createVenv({ project: false });
```

Additional dependencies use the corresponding uv-run concepts:

```ts
const python = createVenv({
  project: './python',
  with: ['httpx>=0.28', 'orjson>=3.10'],
  withEditable: ['../shared-python'],
  withRequirements: ['./requirements/runtime.txt'],
});
```

uv owns project discovery, resolution, environment synchronization, and caching. The worker stays alive for the Venv lifetime, so environment and interpreter startup happen once. Pyfig is used only to find or provision compatible uv and Python executables; Pynect does not depend on Pyfig's command runner.

## Python objects

Common values cross the bridge by value: null, booleans, numbers, strings, bytes, arrays, string-keyed objects, sets, maps, dates, dataclasses, enums, and Pydantic models. Other Python values remain remote references.

```ts
const module = await python.import('my_package');
const client = await module.Client('https://example.com');

console.log(await client.status);
console.log(await client.fetch());
console.log(await client.$repr());
console.log(await client.$dir());
console.log(await client.$value());

await client.$set('timeout', 10);
await client.$release();
```

Property lookup is lazy. Await a property to fetch it, or call it to invoke the Python callable. `$value()` requests a recursive by-value copy when the object supports one. Remote references are also released through JavaScript finalization and all remaining references disappear when the Venv closes.

Python keyword arguments are explicit:

```ts
import { kwargs } from 'pynect';

await module.render('report', kwargs({ format: 'pdf', landscape: true }));
```

Python iterables and async iterables use JavaScript asynchronous iteration:

```ts
const rows = await module.stream_rows();
for await (const row of rows) {
  console.log(row);
}
```

## Callbacks

JavaScript functions passed as arguments become callbacks for that Venv:

```ts
const result = await module.transform([1, 2, 3], async value => {
  return await module.normalize(value);
});
```

Callbacks may be asynchronous and may call back into the same Python Venv. Requests carry independent IDs and the Python worker dispatches nested calls without blocking the callback-result channel.

## Pydantic

`validatePydantic` defaults to `true`. When Pydantic is installed in the selected environment, Pynect binds a callable's signature and validates deserialized annotated arguments through Pydantic before invoking it. Pydantic models returned from Python are serialized with their configured Pydantic serializers.

```ts
const python = createVenv({
  with: ['pydantic>=2,<3'],
  validatePydantic: true,
});
```

Set `validatePydantic: false` to preserve the deserialized values exactly. Pynect does not install Pydantic implicitly.

## Configuration

Important options are:

| Option | Default | Purpose |
| --- | --- | --- |
| `cwd` | `process.cwd()` | uv working directory and first application import path |
| `project` | uv discovery | project directory, or `false` for `--no-project` |
| `with` | `[]` | additional uv requirements |
| `withEditable` | `[]` | additional editable requirements |
| `withRequirements` | `[]` | requirements, pylock, or inline-metadata files |
| `validatePydantic` | `true` | validate annotated inputs when Pydantic is available |
| `autoClose` | `true` | allow natural host exit and terminate the child on shutdown |
| `startupTimeoutMs` | `120000` | environment preparation and worker handshake limit |
| `callTimeoutMs` | `0` | per-call RPC limit; zero disables it |
| `uvArgs` | `[]` | additional `uv run` flags before the worker command |

Python and uv selection options such as `python`, `requiresPython`, `managedPython`, `requiresUv`, `autoInstall`, and installation timeouts are passed to Pyfig.

## Transport and lifecycle

Messages are length-prefixed MessagePack frames. One connection multiplexes calls, responses, callback requests, releases, and shutdown. Windows uses overlapped named-pipe reads and writes so a blocked read does not prevent a callback response or nested call. Python stdout and stderr remain attached to the host rather than carrying protocol traffic.

Use `await using`, call `close()` explicitly, or rely on `autoClose` for process shutdown:

```ts
const python = createVenv({ autoClose: false });
try {
  const module = await python.import('my_package');
  await module.run();
} finally {
  await python.close();
}
```

## Development

```sh
bun install --frozen-lockfile --ignore-scripts
bun run verify
```

MIT licensed.
