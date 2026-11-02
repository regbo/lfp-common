# pyfig

`pyfig` prepares uv and compatible Python venvs from Bun or Node.js. It prefers a valid uv already on the system and searches system Python with downloads disabled before considering a managed Python download.

Pyfig never invokes standalone `pip`, discovers Python project metadata, edits caller-owned requirements files, or creates a project-root `.venv`. Dependency-free callers can reuse a compatible active or project-root venv. A caller that passes dependencies or requirements files gets a content-addressed private venv under `<project-root>/node_modules/.pyfig/venvs/`, so independent libraries cannot replace or downgrade each other's environments.

## Install

```sh
bun add pyfig
```

## Use

```ts
import { Python } from 'pyfig';

const pyenv = new Python({
  dependencies: ['requests>=2.32'],
  requirements: ['requirements/runtime.txt'],
  requiresPython: '>=3.11,<4',
  requiresUv: '>=0.10,<1',
  requireEmbedding: true,
  requireGil: true,
});

const environment = await pyenv.prepare();

console.log(environment.uv);
console.log(environment.python);
console.log(environment.managed);
console.log(environment.venvId);

await pyenv.uv(
  ['run', '--', 'python', 'script.py'],
  { stdio: 'inherit' },
);
```

`dependencies` accepts PEP 508 specifiers. `requirements` accepts explicit requirements-file paths, with relative paths resolved from `projectRoot`. Pyfig does not discover or read `pyproject.toml`, Python lockfiles, or dependency groups. Configuration is bound by the `Python` constructor, so `prepare()`, `uv()`, and `uvSync()` always target the same venv. Temporary resolution inputs are created outside the repository and removed afterward.

The same uv-only surface handles direct commands:

```ts
import { uvSpawn, uvSpawnSync } from 'pyfig';

await uvSpawn(['pip', 'list'], { stdio: 'inherit' });

const result = uvSpawnSync(
  ['run', '--', 'python', '-c', 'import sys; print(sys.executable)'],
  { encoding: 'utf8' },
);
```

For `uv pip` and `uv run`, Pyfig selects the venv and injects its exact interpreter. Caller-supplied target overrides such as `--python`, `--system`, `--target`, `--prefix`, and `--user` are rejected. Inherited target-changing environment variables are removed. Other uv commands run with Pyfig's cache and system-Python preference but are otherwise unchanged.

The async spawn helper returns `Promise<ChildProcess>` because uv or environment setup may happen before spawning. The synchronous helper performs setup through `process.execPath`, so a Bun process remains Bun and does not assume a `node` command exists.

## Selection policy

Pyfig uses this order:

1. A compatible configured or `PATH` uv.
2. Pyfig's cached, checksum-verified uv.
3. For callers without dependencies or requirements files, a compatible explicitly configured venv, active `VIRTUAL_ENV`, or root `.venv`.
4. A compatible base interpreter from those venvs, then every installed system Python reported by uv with downloads disabled.
5. An already-cached uv-managed Python that passes the same checks.
6. A managed Python download, only when installation policy allows it.
7. An existing hashed venv for the exact interpreter and resolved dependencies, or a new venv below `node_modules/.pyfig/venvs`.

An explicit `python` option is strict: an unavailable or incompatible interpreter is an error. Without runtime requirements, an explicitly configured compatible venv can be reused. With dependencies or requirements files, its base interpreter is used for a private venv. Incompatible external venvs are always preserved. Only an incomplete or damaged Pyfig-managed venv may be rebuilt.

![Pyfig prefers existing uv, compatible venvs, and system Python before managed downloads](docs/diagrams/python-selection.png)

[Mermaid source](docs/diagrams/python-selection.mmd)

Native consumers can set `requireEmbedding: true` to require CPython, `Python.h`, a linkable embedding library, and architecture/pointer-width compatibility with the JavaScript runtime. Set `requireGil: true` when the native addon requires the standard GIL-enabled ABI. These checks apply to system, existing-venv, cached, and downloaded interpreters alike.

## Runtime dependency resolution

```ts
const pyenv = new Python({
  dependencies: ['orjson>=3.10', 'httpx[http2]'],
  requirements: ['requirements/runtime.txt'],
});

await pyenv.prepare();
```

Resolution follows the equivalent of:

```sh
uv pip compile /project/requirements/runtime.txt \
  /temporary/runtime-dependencies.txt \
  --python /selected/base/python \
  --no-header --no-annotate --generate-hashes \
  --output-file /temporary/resolved-dependencies.txt

uv venv --python /selected/base/python \
  node_modules/.pyfig/venvs/cpython-3.12.7-0123456789abcdef0123

uv pip install \
  --python /hashed/venv/python \
  -r /temporary/resolved-dependencies.txt
```

The venv identity includes the exact base interpreter, platform, architecture, GIL/ABI properties, and SHA-256 of uv's hash-pinned resolution. Equivalent declarations can share one venv; a different resolution creates another. The metadata file inside each venv is written last and acts as its publication marker.

Only the explicit `dependencies` values and `requirements` files participate in resolution. Known Python project metadata and lockfile paths are rejected as requirements inputs. Pyfig does not use `uv add` or `uv pip sync`, so it neither edits project metadata nor removes packages from an externally owned venv.

Raw `pyenv.uv(['pip', ...])` remains an intentional low-level escape hatch. It can mutate the selected venv after publication and bypass the content-addressing guarantee. Use constructor-level `dependencies` or `requirements` when isolation and repeatability matter.

Separate venvs work for subprocesses and isolated workers. Native libraries that initialize CPython in the same JavaScript process must use one combined compatible dependency set or move each interpreter into a separate worker process; two venv directories cannot provide two independent process-global CPython runtimes.

![Runtime dependencies are resolved in temporary files before installation](docs/diagrams/runtime-dependencies.png)

[Mermaid source](docs/diagrams/runtime-dependencies.mmd)

## Project root

Pyfig does not interpret `package.json`, workspace metadata, `pyproject.toml`, or lockfiles. The root only locates private venv storage and resolves relative requirements-file paths. Root precedence is:

1. `projectRoot`
2. `PYFIG_PROJECT_ROOT`
3. nearest Git worktree marker above `INIT_CWD`, when set, otherwise the current directory
4. that starting directory when no Git marker exists

Set `projectRoot` explicitly in reusable libraries and unusual workspace layouts.

## Public API

| Export | Responsibility |
| --- | --- |
| `new Python(options)` | Bind one immutable venv configuration and memoize its preparation. |
| `pyenv.prepare()` | Resolve and prepare that configuration's exact venv. |
| `pyenv.pythonInfo()` | Return the selected interpreter and embedding metadata. |
| `pyenv.uvInfo()` | Return the selected uv executable and version. |
| `pyenv.uv()` / `pyenv.uvSync()` | Spawn uv and pin pip/run commands to the same venv. |
| `ensureEnvironment(options?)` | Standalone preparation API using the same options. |
| `ensureUv(options?)` | Prefer existing uv, otherwise bootstrap verified uv when allowed. |
| `uvSpawn()` / `uvSpawnSync()` | Standalone uv spawn API. |
| `resolveProjectRoot(start?)` | Resolve the nearest Git root without reading manifests. |

The package exposes matching ESM and CommonJS entry points. Probe, download, lock, and command-policy internals are not exported.

## Configuration

Precedence is API or CLI option, environment variable, then default.

`requiresPython` and `requiresUv` use PEP 440 specifiers. Comma-separated clauses, compatible releases (`~=`), exclusions (`!=`), wildcard equality, arbitrary equality (`===`), and pre-release versions are supported. For example: `requiresPython: '>=3.10,!=3.12.*,<4'` and `requiresUv: '==0.13.*'`. Pyfig reuses a compatible installed or cached uv first. When installation is necessary, it resolves the greatest published uv release satisfying `requiresUv` and containing the required platform assets.

When embedding files are available, `PythonInfo.embedding.stableAbiLibraryPath` identifies the platform's Python 3 Stable ABI import library when the installation provides one. Consumers can use it to build a single Limited API binary for multiple CPython 3 minor versions while retaining `libraryPath` for version-specific embedding.

| API option | Environment variable | Default |
| --- | --- | --- |
| `dependencies` | — | `[]` |
| `requirements` | — | `[]` |
| `python` | `PYFIG_PYTHON` | uv discovery |
| `requiresPython` | `PYFIG_REQUIRES_PYTHON` | `>=3.10,<4` |
| `managedPython` | `PYFIG_MANAGED_PYTHON` | `3.12` |
| `requiresUv` | `PYFIG_REQUIRES_UV` | `>=0.10,<1` |
| `cacheDir` | `PYFIG_HOME` | OS cache directory |
| `projectRoot` | `PYFIG_PROJECT_ROOT` | `INIT_CWD`, Git root, or current directory |
| `requireEmbedding` | `PYFIG_REQUIRE_EMBEDDING` | `false` |
| `requireGil` | `PYFIG_REQUIRE_GIL` | `false` |
| `autoInstall` | `PYFIG_AUTO_INSTALL` | `true` |
| `installPython` | `PYFIG_INSTALL_PYTHON` | `autoInstall` |
| `installUv` | `PYFIG_INSTALL_UV` | `autoInstall` |
| `createVirtualEnvironment` | `PYFIG_CREATE_VIRTUAL_ENVIRONMENT` | `autoInstall` |
| `probeTimeoutMs` | `PYFIG_PROBE_TIMEOUT_MS` | `10000` |
| `installTimeoutMs` | `PYFIG_INSTALL_TIMEOUT_MS` | `600000` |
| `downloadTimeoutMs` | `PYFIG_DOWNLOAD_TIMEOUT_MS` | `300000` |
| `coordinationTimeoutMs` | `PYFIG_COORDINATION_TIMEOUT_MS` | install + download + 60 seconds |

Set `PYFIG_UV` to choose an explicit uv executable. Set `PYFIG_AUTO_INSTALL=0` or use the CLI's `--check` flag on hosts where downloads and environment creation are prohibited.

## CLI

```sh
bunx --bun pyfig
bunx --bun pyfig --check
bunx --bun pyfig --requires-python '>=3.12,<3.14'
bunx --bun pyfig --requires-uv '>=0.12,<1'
bunx --bun pyfig --dependency 'requests>=2.32' --requirement requirements/runtime.txt
bunx --bun pyfig --require-embedding --require-gil
bunx --bun pyfig --project-root /path/to/repository
bunx --bun pyfig --json
```

`bunx --bun` runs the CLI with Bun and does not require a separate Node.js executable.

## Concurrency and installation safety

Pyfig resolves a compatible uv release from Astral's GitHub releases, downloads that exact archive over HTTPS, verifies its adjacent SHA-256 checksum, validates the staged executable version, and atomically publishes it in Pyfig's cache. A compatible cached executable is probed locally without a network request. Release metadata is cached on disk for 24 hours; stale metadata is refreshed under a Loqkit lock and remains available as a fallback when GitHub's API is temporarily unavailable. Set `GITHUB_TOKEN` or `GH_TOKEN` to authenticate release discovery on CI and other rate-limited hosts. Pyfig does not execute installer scripts or modify shell profiles.

Provisioning mutations use Loqkit's layered in-memory, worker, native-file-lock-when-available, and portable-file coordination with capability checks before and after acquisition. Compatible managed uv executables are cached by resolved version; Loqkit coordinates both the `requiresUv` policy lookup and exact release publication. Each hashed venv has its own provisioning key. Creation, installation, and validation finish before the venv metadata marker is published. Preparation is memoized within one `pyenv`; separate processes converge through the same resolved identity and Loqkit lock.

## Platform support

Pyfig bootstraps uv on x64 and arm64 Windows, macOS, and Linux. Linux uses Astral's static musl artifact, which also runs on glibc. Node.js 22.11+ on the 22.x line, Node.js 24.10 through 26.x, and Bun 1.2+ are supported. Other JavaScript runtimes may work when they provide compatible Node built-ins and process semantics.

## Publishing

Pyfig publishes from a `v<package-version>` Git tag through `.github/workflows/publish.yml`. The trusted-publishing workflow validates the tag, rejects an existing registry version, builds and audits one archive, and publishes that archive with provenance.

From a clean, synchronized `main` branch:

```sh
bun run release
```

The local gate derives the next version from remote GitHub tags, verifies locally, audits the package, commits, tags, and atomically pushes. Use `bun run release -- minor`, `bun run release -- major`, or `bun run release -- --dry-run` as needed. Tag publishing intentionally does not repeat the local test suite.

## Development

```sh
bun install --ignore-scripts
bun run verify
bun run build
bun pm pack --dry-run
```

MIT licensed.
