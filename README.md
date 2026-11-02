# pyfig

`pyfig` resolves compatible uv and Python executables from Node.js or Bun and
exposes one guarded `uv run` spawn method. Its only managed state is a uv tool
cache; uv retains responsibility for Python, environments, and dependencies.

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
import { pyfig } from 'pyfig';

const python = await pyfig({
  uv: '>=0.10,<1',
  python: '>=3.11,<4',
  requireEmbedding: true,
  requireGil: true,
});

console.log(python.uv);
console.log(python.python);

python.run('python', '--version', { stdio: 'inherit' });
```

`pyfig()` returns a `PythonContext` containing:

| Field | Meaning |
| --- | --- |
| `uv` | Absolute path to the resolved uv executable. |
| `python` | Absolute path to the resolved Python interpreter. |
| `run(...args)` | Spawn `uv run` with that Python interpreter. |

`run()` treats a final object as Node `SpawnOptions`. When no `--` argument is
present, every string is treated as command argv:

```ts
python.run('python', '--version');
// uv run --python /resolved/python -- python --version
```

When `--` is present, strings before it are passed to uv and strings after it
are command argv:

```ts
python.run('--no-project', '--with', 'httpx', '--', 'python', 'script.py', {
  cwd: '/workspace',
  stdio: 'inherit',
});
```

Pyfig inserts `--python <python>` immediately before the separator. Caller
supplied `--python <value>` and `--python=<value>` arguments are rejected before
`--`; Python is selected only by `pyfig()`. A `--python` appearing after
`--` belongs to the command and is left untouched.

`pyfig()` accepts:

| Option | Default | Meaning |
| --- | --- | --- |
| `uv` | `>=0.10,<1` | uv executable or PEP 440 version constraint. |
| `python` | system, then managed | Python executable or PEP 440 version constraint. |
| `requireEmbedding` | `false` | Require CPython headers, a linkable library, and matching architecture. |
| `requireGil` | `false` | Reject free-threaded Python builds. |
| `cwd` | `process.cwd()` | Directory used for uv configuration and project discovery. |
| `env` | `process.env` | Environment used to locate executables and invoke child processes. |

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

The runtime package exports `pyfig` and `PythonContext`. TypeScript also exposes
`PyfigOptions`. Matching ESM and CommonJS entry points are published.

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
