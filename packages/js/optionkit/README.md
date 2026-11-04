# optionkit

Optionkit turns a Zod configuration schema into CLI options with useful defaults:
project-scoped environment variables, conflict-free short flags, structured
environment parsing, and lazy CLI dependency loading.

## Install

```sh
bun add optionkit
```

## Start with the defaults

```ts
import { createOptionKit } from 'optionkit';

const { f, z } = await createOptionKit();

const appOptionsSchema = z.object({
  port: z.number().default(3000).describe('Port to listen on.'),
  debug: z.boolean().default(false).describe('Write diagnostics to stderr.'),
  logLevel: z.enum(['info', 'warn', 'error']).default('info')
    .describe('Minimum log level.'),
}).readonly();

const serve = f.command({ name: 'serve', description: 'Start the server.' })
  .input(appOptionsSchema)
  .output(z.void())
  .handler(async config => {
    await startServer(config);
  });

await serve.parseAsync(process.argv);
```

For a package named `my-app`, this creates `MY_APP_PORT`, `MY_APP_DEBUG`, and
`MY_APP_LOG_LEVEL`. It also assigns `-p`, `-d`, and `-l`; when option initials
conflict, Optionkit leaves the ambiguous short flags out. Boolean options receive
matching `--no-*` flags, including optional booleans whose `undefined`, `true`,
and `false` states are distinct.

`createOptionKit()` finds the consuming package from the executable at
`process.argv[1]`, falling back to `process.cwd()`, and walks upward to the nearest
`package.json`. Pass `moduleUrl` or `packageRoot` only when a host needs to make
that boundary explicit.

Each `.input(schema)` is adapted independently, so subcommands need no special
setup:

```ts
const program = f.program({ name: 'app' }).router({ serve, status });
await program.parseAsync(process.argv);
```

Optionkit disables Fireargs' buffered `--json` option by default. Opt in on a
command with `f.command({ jsonOption: {} })` when its validated output should be
serialized after the handler completes. Streaming commands can instead expose
their own incremental format without an automatic trailing JSON value.

### Package version

Pass the CLI package's generated version to validate it as SemVer and add
`-v, --version` when a command or program is parsed as the root route:

```ts
import { PACKAGE_VERSION } from './_generated/metadata.js';

const { f, z } = await createOptionKit({
  moduleUrl: import.meta.url,
  version: PACKAGE_VERSION,
});
```

Optionkit never infers a version from a consuming project's `package.json`.
Automatic short-option generation reserves `-v` whenever a version is active,
and invalid versions fail during `createOptionKit()`. Mounted subcommands do not
inherit this option, so wrapper commands can pass their executable's `--version`
through unchanged.

### Environment values

Scalar values keep Fireargs' normal coercion. Array, tuple, object, and record
environment values try JSON first:

```text
MY_APP_TAGS='["one","two"]'
MY_APP_ENV='{"PORT":"3000"}'
```

Arrays also accept comma- or whitespace-delimited shell words with quotes and
backslash escapes. Decoded arrays still use native variadic option handling, so
repeated CLI flags work normally. If decoding does not apply, Zod receives the
original value and remains the final validator.

### Wrapper commands

`passThroughArguments` adds the pass-through command settings and a typed trailing
`args: string[]` input:

```ts
const run = f.command({ name: 'run', passThroughArguments: true })
  .input(appOptionsSchema)
  .output(z.void())
  .handler(async ({ args, ...config }) => runExecutable(config, args));
```

Use `{ description: '...' }` instead of `true` to change the generated positional
help text. The wrapper's own `--help` remains active before the separator; place
`--help` after `--` to send it to the executable.

## Override only what differs

```ts
const kit = await createOptionKit({
  environmentPrefix: 'SERVICE',
  fields: {
    debug: { env: false, short: 'x' },
  },
  moduleUrl: import.meta.url,
  reservedShortFlags: ['v'],
});
```

Available Optionkit-level controls include `projectName`, `environmentPrefix`,
`version`, `shortFlags`, `booleanNegations`, `reservedShortFlags`, per-field metadata,
`invocationDirectory`, `errorFormatter`, and an explicit `cacheDirectory`. A parser registered through `f.option({ parse })`
or the `fields` setting is forwarded unchanged and bypasses automatic structured
decoding.

Optionkit adds `--no-*` twins for booleans and for other option schemas that
explicitly accept `false`, such as `z.union([z.string(), z.literal(false)])`.
The twin writes `false` to the original field, so consumers do not need a
separate `noProject`-style adapter. Set `booleanNegations: false` to disable
these generated flags.

The returned `f` keeps the underlying command, program, option, and argument
configuration available. Refer to the [Fireargs package](https://www.npmjs.com/package/fireargs)
for those builder options instead of learning a second configuration vocabulary.

## Dependency loading and errors

Optionkit first reuses compatible Fireargs and Zod installations from the
consuming package. If either is missing, it detects the caller's package manager
and installs the catalog ranges from the consuming package root without changing
the manifest or lockfile. `cacheDirectory` explicitly opts into an isolated
installation; there is no default version cache.

`@antfu/install-pkg` and `semver` are Optionkit's hard runtime dependencies.
Fireargs and Zod are optional peers, while `clean-stack` is the default optional
error formatter. Their ranges
live in the package catalog and are generated into `src/_generated/catalog.ts` as
a one-to-one runtime mirror.

Set `errorFormatter` to a package name or `{ name, specifier }` to try another
formatter. Optionkit looks for a default, `formatError`, or `format` function
export. It first imports the package from the CLI project, then tries a no-save
installation through `@antfu/install-pkg` and imports it again. Import,
installation, export-shape, and formatter-execution failures never block the CLI;
formatting falls back to the original stack. Set `errorFormatter: false` to skip
the optional integration.

Rejected handlers and renderers are formatted at the `parseAsync` boundary,
written to the command's configured error output, and set exit code 1 by default.
Set `formatErrors: false` to keep rejection handling in the consumer. The returned
`formatError(error)` uses the same formatter and falls back to the original stack.

Use the returned `z` when the consumer does not otherwise depend on Zod; it is
resolved from the same location as the CLI adapter. `resolvePackage` and
`importPackageIfAvailable` expose the same resolve-first behavior for other
optional integrations and only suppress a genuinely missing package.

Optionkit also exposes its Projen-generated package identity from
`optionkit/metadata`:

```ts
import { PACKAGE_NAME, PACKAGE_VERSION } from 'optionkit/metadata';
```

## License

MIT
