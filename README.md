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

## Python-only code generation

The generator is a self-contained uv script. Generating bindings does not start
Node or Bun and does not require either executable to be installed. uv reads the
script's inline dependencies and caches its small CLI environment:

```sh
uv run --script python/pynect_codegen.py generate \
  --module name_generator \
  --module my_project.models \
  --class-name MyProjectPython \
  --project . \
  --out generated/my-project-python.ts
```

A module passed without an explicit alias uses its final import segment. If names
conflict, the generator prepends one package parent at a time until they are
unique. For example, `one.shared.name_generator` and
`two.shared.name_generator` become `one_shared_name_generator` and
`two_shared_name_generator`. Use `alias=package.module` when you want to choose
the public name yourself.

For one module, `--class-name` is optional and is derived from its public alias:
`name_generator` generates `NameGeneratorPython`. Generating multiple modules
requires an explicit `--class-name` (or `className` in the JSON settings).

It imports the selected Python modules, inspects their public functions and
classes, translates annotations, and emits:

- module and class interfaces;
- a typed module map for `PythonVenv`;
- a lazy project class with typed module getters;
- the configured `CreateVenvOptions`, including project and uv dependency options.

### Project configuration

For a Python project, keep the generator settings in `pyproject.toml`:

```toml
[tool.pynect.codegen]
modules = ["name_generator", "my_project.models"]
className = "MyProjectPython"
out = "../node-wrapper/src/generated/my-project-python.ts"
project = "."
with = ["httpx>=0.28"]
withEditable = []
withRequirements = []
uvArgs = []
validatePydantic = true
```

Then generation is one command:

```sh
uv run --script scripts/pynect_codegen.py generate
```

`modules` may be a list using automatic aliases or an alias-to-import mapping.
The same fields work in a standalone JSON file:

```json
{
  "className": "MyProjectPython",
  "out": "generated/my-project-python.ts",
  "project": ".",
  "with": ["httpx>=0.28"],
  "modules": ["name_generator", "my_project.models"]
}
```

```sh
uv run --script scripts/pynect_codegen.py generate --config pynect.codegen.json
```

In `package.json`, place that same object under `pynect.codegen`. Configuration
precedence is CLI flags, `PYNECT_CODEGEN_*` environment variables, the discovered
`pyproject.toml` or `package.json`, then defaults. Sequence-valued environment
variables accept JSON arrays or comma-separated values; `PYNECT_CODEGEN_MODULES`
also accepts a JSON alias map.

The generated TypeScript imports `pynect` only when the bindings are later
consumed by a JavaScript application. Because inspection imports the requested
Python modules, run the generator only against trusted projects and packages.

### Generate on save

Run setup from the copy shipped with the Node wrapper dependency:

```sh
uv run --script ../node-wrapper/node_modules/pynect/python/pynect_codegen.py \
  setup-dev --root . --dry-run

uv run --script ../node-wrapper/node_modules/pynect/python/pynect_codegen.py \
  setup-dev --root .
```

Setup copies the same script to `scripts/pynect_codegen.py`, adds
`pucelle.run-on-save` to `.vscode/extensions.json`, and adds a debounced Python
save command to `.vscode/settings.json`. The generated setting uses
`runOnSave.ignoreFilesBy = [".gitignore"]`, so ignored Python files do not trigger
generation. [Run on Save](https://marketplace.visualstudio.com/items?itemName=pucelle.run-on-save)
is the recommended extension because it supports `.gitignore`, glob matching,
debouncing, and quiet background commands directly.

The setup command merges valid JSON files and is idempotent. It refuses to
rewrite JSON-with-comments because doing so would discard comments; convert those
workspace files to plain JSON or add the documented entries manually.

### Generate during Python builds

When the Python project uses Hatchling, `setup-dev` configures the copied script
as the custom build hook:

```toml
[tool.hatch.build.hooks.custom]
path = "scripts/pynect_codegen.py"
```

Hatchling imports that same file and calls the same settings loader, inspector,
and renderer immediately before the build. PEP 517 does not define a generic
pre-build command. In particular, `uv_build` deliberately omits build scripts;
uv recommends Hatchling when they are required. Setup therefore leaves other
build backends unchanged and reports that the hook was skipped. See the
[Hatch custom-hook documentation](https://hatch.pypa.io/1.0/plugins/build-hook/)
and [uv build-backend guidance](https://docs.astral.sh/uv/concepts/build-backend/).

Generated code can also supply its module map directly without a wrapper class:

```ts
interface Modules {
  names: {
    generate_name(): Promise<string>;
  };
}

const python = createVenv<Modules>({
  modules: { names: 'name_generator' },
});

const names = await python.import('names');
```

## Configuration

Important options are:

| Option | Default | Purpose |
| --- | --- | --- |
| `cwd` | `process.cwd()` | uv working directory and first application import path |
| `project` | uv discovery | project directory, or `false` for `--no-project` |
| `with` | `[]` | additional uv requirements |
| `withEditable` | `[]` | additional editable requirements |
| `withRequirements` | `[]` | requirements, pylock, or inline-metadata files |
| `modules` | `{}` | public aliases mapped to Python import names |
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
