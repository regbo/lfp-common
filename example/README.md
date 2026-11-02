# Pynect example

This example has two small projects:

- `python/` contains the Python module exposed through Pynect.
- `app/` contains a TypeScript consumer that runs with Bun or Node.js.

From `example/app`, install dependencies and generate the typed bridge:

```sh
bun install
bun run generate
```

The generate script invokes `pynect codegen` from the local `pynect` dependency.

Run it with Bun:

```sh
bun run start
```

Or run the same TypeScript entry point with Node.js 22.18 or newer:

```sh
bun run start:node
```

Run the cold/warm native-Python versus JavaScript-callback benchmark:

```sh
bun run benchmark
```

The benchmark creates 2,000 objects in Python. Cold measurements include
environment and worker startup. Warm measurements reuse the same worker and
report filtering done entirely in Python versus one bridge callback per object.

The generated `src/generated/example-python.ts` file reads the Python project path from `python/pyproject.toml`, starts its uv-managed environment lazily, and exposes typed methods from `calculator.py`.
