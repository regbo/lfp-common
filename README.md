# optionkit

`optionkit` turns a Zod configuration schema into CLI options. It adds
environment-variable bindings, adds unambiguous short flags, and lazily loads
the CLI stack without making Fireargs, Commander, or Zod runtime dependencies
of this package.

```ts
import { createOptionKit } from 'optionkit';

const { f, z } = await createOptionKit({ moduleUrl: import.meta.url });

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

If the consuming package is named `my-app`, the fields above receive
`MY_APP_PORT`, `MY_APP_DEBUG`, and `MY_APP_LOG_LEVEL`. `port`, `debug`, and
`logLevel` also receive `-p`, `-d`, and `-l` because their initials do not
conflict. When two options share an initial, neither gets that automatic short
flag.

Adaptation happens at each command's `.input(...)` boundary. Subcommands need no
special handling: build each leaf from its own schema, then mount the leaves with
`f.program(...).router({ serve, status })`. Environment and short-flag conflicts
are calculated independently for each leaf.

## Lazy CLI dependencies

optionkit first resolves Fireargs and Zod from the consuming CLI package. If
they are unavailable, it detects the package manager from the invocation
directory and installs the pinned Fireargs and Zod ranges from the consuming
package root. `cacheDirectory` opts into an isolated install explicitly; there
is no default versioned cache. Fireargs' package metadata supplies its remaining
peer dependencies. Optionkit restores the consuming manifest and lockfile
byte-for-byte after installation, and installer output stays silent so JSON
output is not polluted.

Only `@antfu/install-pkg` is a runtime dependency of optionkit. Fireargs,
Zod, and `clean-stack` are development dependencies whose ranges are generated
into the build from the catalog in `pnpm-workspace.yaml`. A matching root
catalog keeps Bun compatible, and verification fails if the two catalogs
diverge. `src/_generated/catalog.ts` is a one-to-one runtime mirror of the root
catalog. The stack cleaner is installed separately and best-effort: a failure
never prevents the CLI from starting, and `formatError` falls back to the
original stack. Fireargs and Zod are also declared as optional peers, so a
consumer's compatible installation is reused without making either package a
required install.

Use the returned `z` when the consuming package does not otherwise depend on
Zod. It always comes from the same dependency location as the CLI adapter:

```ts
const { f, z } = await createOptionKit({ moduleUrl: import.meta.url });
const input = z.object({ verbose: z.boolean().default(false) });
```

Use `environmentPrefix` or `projectName` to override automatic package-name
translation. Per-field `env` and `short` values can be overridden or disabled:

```ts
await createOptionKit({
  environmentPrefix: 'SERVICE',
  fields: {
    debug: { env: false, short: 'x' },
  },
  moduleUrl: import.meta.url,
});
```

Array, tuple, object, and record options with generated environment bindings try
JSON first because an environment variable supplies only one string. For example,
`APP_TAGS='["one","two"]'` and `APP_ENV='{"PORT":"3000"}'` become their
corresponding Zod input values. Arrays also accept comma- or whitespace-delimited
shell words, including quotes and backslash escapes. If decoding does not apply,
the original string reaches Zod as the final authority. Fireargs continues to
handle scalar coercion. The same structured syntax works when passed as a flag.
A consumer-supplied Fireargs `parse` function is forwarded unchanged and takes
precedence over this augmentation. Every other per-option Fireargs configuration
field is forwarded as well; command and program configuration remains available
through the returned `f` namespace.

Fireargs programs currently show help when invoked without a subcommand. Optionkit
does not override that dispatch: Commander only exposes a clean default-command
switch while adding a command, whereas Fireargs owns that mounting step. A shim
would either depend on Commander internals or duplicate Fireargs routing.

`resolvePackage` and `importPackageIfAvailable` expose the same resolve-first
behavior for other optional integrations. They only suppress a genuinely
missing package; initialization errors from an installed package still surface.

## Pyfig migration

Pyfig can keep `pyfigOptionsSchema` as its API source of truth. Its CLI only
needs to replace the manual loader; Optionkit adapts every command input:

```ts
const { f, z } = await createOptionKit({
  log,
  moduleUrl: import.meta.url,
});

const createInput = (passthrough = false) => pyfigOptionsSchema.unwrap().extend({
  ...(passthrough ? { args: f.argument().schema(passthroughArguments) } : {}),
});
```

The command, router, output schemas, handlers, and passthrough behavior do not
change. `PYFIG_*` names and conflict-free short flags are derived automatically.
Pyfig needs only `optionkit` for its CLI integration; it does not need its own
Fireargs peer metadata, Fireargs development dependency, or install helper.

## Install

```sh
bun add optionkit
```

## License

MIT
