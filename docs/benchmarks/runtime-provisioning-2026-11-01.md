# Runtime provisioning benchmark: Windows and Docker

Date: 2026-11-01. Pyfig source: `v0.4.0` (`6b77101`). Warm samples: three fresh Bun processes per scenario.

## Summary

Pyfig reused every compatible environment and preferred system Python in every scenario where it was available. All new environments were created at `node_modules/.pyfig/venv`. No `pyproject.toml`, requirements file, package manifest, or project-root `.venv` was created or edited by Pyfig.

The fastest cold path was Docker with system uv and system Python: 0.233 seconds to create a private venv. A completely empty Alpine environment with only Bun took 4.608 seconds to download verified uv, download Python, and create the venv. On Windows, bootstrapping missing uv while reusing system Python took 3.196 seconds; downloading managed Python took 12.467 seconds.

Warm preparation was 47-105 milliseconds in Docker for most cases and 222-476 milliseconds on Windows. Every warm snapshot had zero created, modified, or removed project/cache entries.

## Method

Each scenario used a new directory under the operating system's temporary directory and a separate Pyfig cache. Cold results are one real provisioning run. Warm results are the median of three new Bun processes against the cold state, avoiding in-process client memoization.

Two timings are reported:

- **API**: elapsed time around `createPyfig(...).prepare(...)` inside the worker.
- **Process**: Bun startup, module loading, and preparation. Dependency import verification is excluded from this value.

The dependency scenario first created an empty private venv outside the timed section, then installed `idna==3.10`. A separate `import idna` check succeeded after every measured install but is excluded from both reported timings.

Filesystem snapshots include files, directories, and links. Byte totals count regular-file contents, not filesystem allocation or container image layers.

## Test hosts

### Windows

- Windows 11 Pro 10.0.26100, x64
- Intel Core i7-7800X, 12 logical CPUs
- 68,404,318,208 bytes visible RAM
- Bun 1.4.4
- System uv 0.10.7
- System Python selected by Pyfig: CPython 3.11.9

### Docker

- Docker Desktop client 25.0.2 / server 29.7.2
- Linux 6.6.87.1 under WSL2, x64, 12 CPUs, 33,499,082,752 bytes visible RAM
- Base image: `oven/bun:1-alpine`, image ID `sha256:4b7bbb143cb445ac2baba42a460cbc506c7a5022d4f32ff84bf3e76fa493df33`
- Bun 1.4.4
- Alpine system uv 0.11.19 where installed
- Alpine system Python 3.14.10 where installed

Docker results measure containers on Docker Desktop/WSL2, not a bare-metal Linux host.

## Windows results

### Time

| Scenario | Selected toolchain | Cold API | Warm API median | Cold process | Warm process median |
| --- | --- | ---: | ---: | ---: | ---: |
| Existing uv, new private venv | uv 0.10.7 + system Python 3.11.9 | 0.850 s | 0.298 s | 1.149 s | 0.478 s |
| Missing uv, system Python | cached uv 0.13.6 + system Python 3.11.9 | 3.196 s | 0.222 s | 3.384 s | 0.407 s |
| Reuse root `.venv` | uv 0.10.7 + system Python 3.11.9 | 0.313 s | 0.312 s | 0.492 s | 0.491 s |
| Add `idna` to seeded private venv | uv 0.10.7 + system Python 3.11.9 | 0.885 s | 0.476 s | 1.074 s | 0.657 s |
| No compatible system Python | uv 0.10.7 + managed Python 3.12.12 | 12.467 s | 0.345 s | 12.645 s | 0.524 s |

### Filesystem impact

| Scenario | Cold project delta | Cold cache delta | Final project | Final cache |
| --- | ---: | ---: | ---: | ---: |
| Existing uv, new private venv | 24 entries / 0.547 MiB | 10 / 0.001 MiB | 0.547 MiB | 0.001 MiB |
| Missing uv, system Python | 21 / 0.542 MiB | 14 / 30.331 MiB | 0.542 MiB | 30.331 MiB |
| Reuse root `.venv` | 2 / 0.004 MiB | 0 / 0 MiB | 0.546 MiB | 0 MiB |
| Add `idna` to seeded private venv | 24 / 0.454 MiB | 29 / 0.375 MiB | 1.000 MiB | 0.376 MiB |
| Managed Python fallback | 24 / 0.122 MiB | 3,611 / 60.025 MiB | 0.122 MiB | 60.025 MiB |

The missing-uv cache contains `tools/uv/0.13.6` and `uv-cache`. The managed-Python cache contains `python` and `uv-cache`. With existing uv and system Python, the cache contained only about 915 bytes of uv metadata.

Reusing the root `.venv` did not create `node_modules` or a Pyfig cache. The first interpreter launch created `.venv/Lib/site-packages/__pycache__/_virtualenv.cpython-311.pyc` (4,582 bytes) through normal Python bytecode caching. Subsequent runs made no changes.

## Docker results

### Time

| Image state | Operation | Selected toolchain | Cold API | Warm API median | Cold process | Warm process median |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Bun only | Bootstrap private venv | cached uv 0.13.6 + managed Python 3.12.16 | 4.608 s | 0.047 s | 4.750 s | 0.182 s |
| Bun only | Add `idna` after bootstrap | same | 0.538 s | 0.090 s | 0.671 s | 0.225 s |
| System Python, no uv | Bootstrap private venv | cached uv 0.13.6 + system Python 3.14.10 | 1.939 s | 0.049 s | 2.088 s | 0.180 s |
| System Python, no uv | Add `idna` after bootstrap | same | 0.520 s | 0.091 s | 0.653 s | 0.224 s |
| System uv, no Python | Bootstrap private venv | uv 0.11.19 + managed Python 3.12.13 | 3.953 s | 0.056 s | 4.104 s | 0.199 s |
| System uv, no Python | Add `idna` after bootstrap | same | 0.609 s | 0.105 s | 0.782 s | 0.265 s |
| System uv and Python | Bootstrap private venv | uv 0.11.19 + system Python 3.14.10 | 0.233 s | 0.080 s | 0.386 s | 0.234 s |
| System uv and Python | Reuse root `.venv` | same | 0.061 s | 0.060 s | 0.220 s | 0.209 s |
| System uv and Python | Add `idna` to seeded venv | same | 0.729 s | 0.101 s | 0.902 s | 0.255 s |

### Filesystem impact

| Image state and operation | Cold project delta | Cold cache delta | Final project | Final cache |
| --- | ---: | ---: | ---: | ---: |
| Bun only: bootstrap | 24 entries / 0.029 MiB | 4,781 / 117.013 MiB | 0.029 MiB | 117.013 MiB |
| Bun only: add `idna` | 24 / 0.448 MiB | 33 / 0.550 MiB | 0.477 MiB | 117.564 MiB |
| System Python, no uv: bootstrap | 24 / 0.029 MiB | 14 / 41.339 MiB | 0.029 MiB | 41.339 MiB |
| System Python, no uv: add `idna` | 24 / 0.453 MiB | 28 / 0.357 MiB | 0.482 MiB | 41.696 MiB |
| System uv, no Python: bootstrap | 27 / 0.035 MiB | 4,763 / 75.658 MiB | 0.035 MiB | 75.658 MiB |
| System uv, no Python: add `idna` | 24 / 0.448 MiB | 31 / 0.538 MiB | 0.483 MiB | 76.197 MiB |
| Full toolchain: bootstrap | 27 / 0.035 MiB | 10 / 0.001 MiB | 0.035 MiB | 0.001 MiB |
| Full toolchain: reuse root `.venv` | 2 / 0.005 MiB | 0 / 0 MiB | 0.035 MiB | 0 MiB |
| Full toolchain: add `idna` | 24 / 0.453 MiB | 27 / 0.375 MiB | 0.488 MiB | 0.376 MiB |

The zero-toolchain cache contains verified uv under `tools`, managed Python under `python`, and uv's shared cache under `uv-cache`. The system-Python/no-uv case omits `python`; the system-uv/no-Python case omits `tools`.

The Linux root `.venv` probe created only `lib/python3.14/site-packages/__pycache__/_virtualenv.cpython-314.pyc` (5,049 bytes). Subsequent runs were read-only.

## Dependency constraint behavior

Three additional fresh-project checks used these immutable package versions:

- The environment started with `urllib3==2.8.0` and unrelated `idna==3.10`.
- `botocore==1.34.0` requires `urllib3>=1.25.4,<2.1` on Python 3.10 and newer.
- The compatible project declared `urllib3>=1.25.4,<3`.
- The incompatible project declared `urllib3>=2.2,<3`.

| Platform | uv | Compatible guarded downgrade | Guarded conflict rejection | Raw incompatible install |
| --- | ---: | ---: | ---: | ---: |
| Windows, Python 3.11.9 | 0.10.7 | 6.135 s | 0.414 s | 3.506 s |
| Docker full toolchain, Python 3.14.10 | 0.11.19 | 2.001 s | 0.082 s | 0.550 s |
| Docker Bun-only, managed Python 3.12.16 | 0.13.6 | 1.673 s | 0.071 s | 0.523 s |

`prepare(['botocore==1.34.0'])` handled the compatible project correctly. uv resolved `urllib3==2.0.7`, which satisfies both the broad project range and botocore, then downgraded 2.8.0 to 2.0.7. `idna==3.10` remained installed and `pyproject.toml` remained byte-for-byte unchanged.

The same guarded call against `urllib3>=2.2,<3` failed during `uv pip compile`. The complete `uv pip freeze` output was identical before and after; urllib3 stayed at 2.8.0, botocore was absent, idna remained installed, and the project file was unchanged. This confirms that the compile-before-install path rejects an unsatisfiable addition without partially mutating the environment.

Raw `client.uvSync(['pip', 'install', 'botocore==1.34.0'])` behaved differently. It installed botocore and downgraded urllib3 to 2.0.7 even though that violates the project's `urllib3>=2.2,<3` declaration. `uv pip check` still passed because it validates installed distribution metadata, not `pyproject.toml` constraints. The project file was not edited, but the environment no longer matched it.

The project-aware runtime-dependency API is therefore `prepare(dependencies)`. Direct `uv pip install` is intentionally a low-level escape hatch: Pyfig pins it to the selected interpreter but does not reinterpret the command or apply project constraints. Consumers that want preflight guarantees should use `prepare()`; consumers that deliberately choose raw uv retain uv's native behavior.

## Observations

- System Python materially reduces cold time and storage. In Docker, preserving system Python but removing uv cost 1.939 seconds and 41.339 MiB; preserving uv but removing Python cost 3.953 seconds and 75.658 MiB.
- A zero-toolchain Bun container worked without prior Python or uv setup. Its cold cost was 4.608 seconds and 117.013 MiB in Pyfig's cache.
- Existing compatible venvs were reused. Pyfig did not create its private `node_modules/.pyfig/venv` when a root `.venv` was present.
- Adding a dependency changed only the selected venv and Pyfig's uv cache. Temporary compile inputs were removed, and no dependency declaration file appeared in the project.
- Repeating any scenario caused zero project/cache filesystem mutations after the initial cold run.
- Windows warm checks were slower than Docker warm checks on this host. This is consistent with higher process and filesystem overhead on Windows/NTFS, but the benchmark does not isolate antivirus, filesystem, or scheduler effects.
- Download timings are observations from one network and one cold run per scenario. They are useful for relative behavior on this host, not as universal service-level guarantees.

## Reproduction

Run the Windows suite:

```powershell
bun run scripts/benchmark-runtime.ts --suite windows --warm-runs 3
```

Run the dependency-constraint probe:

```powershell
bun run scripts/dependency-resolution-probe.ts
```

Build and run a Docker target:

```powershell
docker build --file tests/docker/Dockerfile.benchmark --target zero --tag pyfig-benchmark-zero .
docker run --rm pyfig-benchmark-zero
```

Available Docker targets are `zero`, `system-python`, `uv-only`, and `full`. Their stable image names in this run were `pyfig-benchmark-zero`, `pyfig-benchmark-system-python`, `pyfig-benchmark-uv-only`, and `pyfig-benchmark-full`.
