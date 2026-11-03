# pyfig

`pyfig` resolves or provisions uv and returns a small runtime context for uv and
Python. UV owns Python selection, managed downloads, project discovery, and
environment behavior.

## Install

```sh
bun add pyfig
```

## Use

```ts
import { once } from 'node:events';
import { pyfig } from 'pyfig';

const context = await pyfig({
  uv: '>=0.10,<1',
  python: '>=3.11,<4',
});

console.log(context.uv.path, context.uv.version, context.uv.source);
console.log(context.python.resolved); // false
await context.python.resolve();
console.log(context.python.path, context.python.version);
console.log(context.python.resolved); // true

const child = await context.python.spawn('-c', 'print("hello")');
await once(child, 'close');
```

The context has two immutable fields:

| Field | Public values |
| --- | --- |
| `uv` | `path`, `version`, `source`, and async `spawn()` |
| `python` | `resolved`, `path`, `version`, async `resolve()`, and async `spawn()` |

`pyfig()` resolves uv immediately. Python remains unresolved until the first
call to `python.resolve()` or `python.spawn()`. Both share one memoized
resolution. Before that, `path` and `version` are `undefined`, and `resolved` is
`false`. Awaiting `spawn()` resolves Python before returning its Node
`ChildProcess`; the user command itself runs exactly once through `uv run`.

Both spawn helpers accept string arguments followed by an optional Node
`SpawnOptions` object. Their defaults are the context working directory and
environment, inherited standard I/O, and a hidden Windows console window.

```ts
const child = await context.uv.spawn('--version', {
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

## Python resolution

The `python` option is passed unchanged to `uv run --python`. It may be any
request UV supports, including a version, implementation, variant, or
interpreter path. Omit it to let UV use the current project, Python pin, or its
normal default.

UV considers applicable environments and installed interpreters before a
managed download. Pyfig does not search hard-coded Python locations. It exposes
the UV-selected interpreter only after explicit resolution. Every user command
executes through `uv run`, so UV remains responsible for project locking,
lockfile policy, and environment synchronization. Use UV's documented
environment variables, including `UV_NO_PROJECT`, `UV_NO_SYNC`, `UV_FROZEN`,
`UV_OFFLINE`, and `UV_PROJECT`, to change that behavior without adding a second
Pyfig policy layer.

For UV before 0.11, Python downloads normally originate from GitHub. If that
attempt specifically fails at the canonical python-build-standalone GitHub
release URL, Pyfig retries once through Astral's official mirror. It does not
override `UV_PYTHON_INSTALL_MIRROR`, `UV_PYTHON_DOWNLOADS_JSON_URL`, or
`UV_ASTRAL_MIRROR_URL`. UV 0.11 and later owns its native mirror order and
fallback behavior.

Concurrent `resolve()` calls and Python spawns share one in-flight resolution
through Loqkit. A successful resolution remains cached for that context and
sets `resolved` to `true`. Failures do not: a later call retries, allowing
recovery after a VPN, proxy, DNS, or registry outage. Calls with a custom `cwd`
or `env` resolve against those overrides instead of reusing the context
resolution. An `AbortSignal` can stop one caller from waiting without
cancelling resolution shared by another caller.

## UV resolution

For a UV version constraint, Pyfig:

1. Lazily probes `PATH` entries in order and stops at the first compatible uv.
2. Probes cached versions from greatest to least and stops at the first valid uv.
3. Reads Astral's official release manifest, downloads the selected platform
   artifact, verifies its published SHA-256 checksum, and publishes the probed
   executable to Pyfig's cache.

An explicit UV executable takes precedence over version parsing:

```ts
const context = await pyfig({ uv: '/opt/bin/uv' });
```

`pyfig()` accepts:

| Option | Default | Meaning |
| --- | --- | --- |
| `uv` | `>=0.10,<1` | UV executable or PEP 440 version constraint. |
| `python` | UV default | Python request passed unchanged to UV on first resolution. |
| `cwd` | `process.cwd()` | Directory used for UV project and configuration discovery. |
| `env` | `process.env` | Environment used during resolution and child processes. |
| `debug` | `false` | Write resolution diagnostics to standard error. |

Compatible cached UV executables require no network access. Release metadata is
cached for 24 hours and refreshed through Loqkit's coordinated check-lock-check
flow. The cache lives below `%LOCALAPPDATA%\pyfig` on Windows,
`~/Library/Caches/pyfig` on macOS, and `${XDG_CACHE_HOME:-~/.cache}/pyfig` on
Linux. `PYFIG_CACHE_DIR` overrides that location.

By default, release metadata and artifacts use Astral first and canonical
GitHub second. `UV_ASTRAL_MIRROR_URL`, `UV_INSTALLER_GITHUB_BASE_URL`, and
`UV_INSTALLER_GHE_BASE_URL` are honored as exclusive custom sources; Pyfig does
not escape to public infrastructure when one applies. A custom installer base
also requires `UV_ASTRAL_MIRROR_URL` for release metadata. Provisioning uses
JavaScript extraction and needs no Python, PowerShell, shell, `curl`, or `wget`.

The runtime package exports `pyfig`, `pyfigOptionsSchema`, `DEFAULT_UV`, and
`PythonContext`. TypeScript also exports `PyfigOptions`, `UvExecutable`,
`PythonExecutable`, and `UvSource`. Matching ESM and CommonJS entry points are
published.

## CLI

The optional CLI resolves uv and Python before printing their metadata:

```sh
pyfig resolve --python ">=3.11,<4"
pyfig resolve --json
```

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
