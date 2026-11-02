# pyfig

`pyfig` resolves or provisions compatible uv and Python executables from Node.js
or Bun. Its only managed state is a uv tool cache; uv retains responsibility for
Python, environments, dependencies, and command execution.

## Install

```sh
bun add pyfig
```

Pyfig reuses a compatible uv from `PATH` or its OS cache. When neither exists,
it installs the greatest official uv release allowed by the requested version.
Python discovery and managed installation are delegated to
[`uv python find`](https://docs.astral.sh/uv/reference/cli/#uv-python-find).

## Use

```ts
import { once } from 'node:events';
import { pyfig } from 'pyfig';

const python = await pyfig({
  uv: '>=0.10,<1',
  python: '>=3.11,<4',
  requireEmbedding: true,
  requireGil: true,
});

console.log(python.uv.path, python.uv.version);
console.log(python.python.path, python.python.version);

const child = python.uv.spawn('pip', 'list');
const completed = python.python.spawn('-c', 'print("hello")');
await once(completed, 'close');
console.log(completed.exitCode, completed.signalCode);
```

Both resolved executables expose `spawn(...args, options?)`, which returns
Node's `ChildProcess` immediately. The optional final argument accepts Node's
built-in `SpawnOptions`. Use `once(child, 'close')` from `node:events` when the
caller needs to wait. Defaults are the resolved working directory and
environment, inherited standard I/O, and a hidden console window on Windows.
Caller options can override those defaults except `UV_PYTHON`, which is always
pinned to the resolved interpreter. `python.spawn()` executes `uv run python`;
its string arguments are forwarded unchanged.

## CLI

The package includes a `pyfig` executable with flags derived from the same Zod
schemas used by the library:

```sh
pyfig resolve --python ">=3.11,<4" --require-embedding --require-gil
```

The `uv` and `python` subcommands resolve the requested executables and inherit
the caller's standard input, output, error, environment, and working directory.
Both set `UV_PYTHON` to the resolved Python path. The `python` command executes
`uv run python`, while `uv` executes uv directly:

```sh
pyfig python --version
pyfig python --python "<3.11" --uv "<0.10" -- --version
pyfig uv --python ">=3.12,<4" -- pip list
```

Use `--` when a child argument could otherwise be parsed as a Pyfig option. Use
`pyfig resolve --json` for structured metadata or `pyfig --llms` for Fireargs'
tool manifest. Environment overrides can be passed as a JSON object:

```sh
pyfig resolve --env '{"UV_PYTHON_PREFERENCE":"only-system"}'
```

When invoked, the CLI installs Fireargs and its Commander peer into the current
project through `@antfu/install-pkg`, then runs the generated command. They are
not installed or loaded when Pyfig is used only as a library.

`pyfig()` returns an immutable `PythonContext` containing:

| Field | Meaning |
| --- | --- |
| `uv` | Immutable resolved uv metadata with a `spawn()` method. |
| `python` | Immutable resolved Python metadata with a `spawn()` method. |

`pyfig()` accepts:

| Option | Default | Meaning |
| --- | --- | --- |
| `uv` | `>=0.10,<1` | uv executable or PEP 440 version constraint. |
| `python` | system, then managed | Python executable or PEP 440 version constraint. |
| `requireEmbedding` | `false` | Require CPython headers, a linkable library, and matching architecture. |
| `requireGil` | `false` | Reject free-threaded Python builds. |
| `cwd` | `process.cwd()` | Directory used for uv configuration and project discovery. |
| `env` | `process.env` | Environment used during executable resolution and provisioning. |

For both `uv` and `python`, Pyfig first checks whether the value resolves to an
executable. An executable wins over version parsing. An explicit uv executable
is trusted without a version check or setup. An explicit Python executable skips
version selection and installation, but it must still be a working Python and
satisfy requested embedding, architecture, and GIL capabilities. A value that
is not executable must be a valid PEP 440 specifier.

For a Python version specifier, Pyfig first asks uv for a matching system
interpreter. If it is absent or fails the requested capabilities, Pyfig asks uv
for a managed interpreter. For a uv version specifier, Pyfig checks `PATH`, then
its cache, then downloads a matching checksum-verified release. Cached
executables are used without a metadata or network request. Release metadata is
cached for 24 hours and refreshed under Loqkit's layered check-lock-check flow.
The cache lives below `%LOCALAPPDATA%\pyfig` on Windows,
`~/Library/Caches/pyfig` on macOS, and `${XDG_CACHE_HOME:-~/.cache}/pyfig` on
Linux.

Executable paths can be used directly:

```ts
const python = await pyfig({
  uv: '/opt/bin/uv',
  python: '/opt/python/bin/python3',
  requireEmbedding: true,
});
```

The runtime package exports `pyfig`, `pyfigOptionsSchema`, `DEFAULT_UV`, and
`PythonContext`. TypeScript also exposes `PyfigOptions` and
`ResolvedExecutable`. Matching ESM and CommonJS entry points are published for
the library API.

## Development

```sh
bun install --ignore-scripts
bun run verify
bun run build
```

## Publishing

From a clean, synchronized `main` branch, `bun run release` verifies locally,
builds and audits the package, commits the next version, creates its Git tag,
and pushes both atomically. The tag workflow publishes that exact package to
npm through trusted publishing.
