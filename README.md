# optionkit

`optionkit` turns a Zod configuration schema into CLI options. It adds
environment-variable bindings, adds unambiguous short flags, and lazily loads
the CLI stack without making Fireargs, Commander, or Zod runtime dependencies
of this package.

```ts
import { createOptionKit } from 'optionkit';
import { z } from 'zod';

const appOptionsSchema = z.object({
  port: z.number().default(3000).describe('Port to listen on.'),
  debug: z.boolean().default(false).describe('Write diagnostics to stderr.'),
  logLevel: z.enum(['info', 'warn', 'error']).default('info')
    .describe('Minimum log level.'),
}).readonly();

const { f, options } = await createOptionKit(appOptionsSchema, {
  moduleUrl: import.meta.url,
});

const serve = f.command({ name: 'serve', description: 'Start the server.' })
  .input(z.object(options))
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

## Lazy CLI dependencies

optionkit first resolves Fireargs and Zod from the consuming CLI package. If
they are unavailable, it detects the package manager from the invocation
directory and installs the pinned Fireargs and Zod ranges together in a
versioned user cache. Fireargs' own package metadata supplies its remaining
peer dependencies. The consuming package's manifest and lockfile remain
unchanged, and installer output stays silent so JSON output is not polluted.

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

For a CLI that does not otherwise use Zod, pass a schema factory to guarantee
that the schema uses the same cached Zod instance as Fireargs:

```ts
const { f, z, options } = await createOptionKit(
  z => z.object({ verbose: z.boolean().default(false) }),
  { moduleUrl: import.meta.url },
);
```

Use `environmentPrefix` or `projectName` to override automatic package-name
translation. Per-field `env` and `short` values can be overridden or disabled:

```ts
await createOptionKit(appOptionsSchema, {
  environmentPrefix: 'SERVICE',
  fields: {
    debug: { env: false, short: 'x' },
  },
  moduleUrl: import.meta.url,
});
```

`resolvePackage` and `importPackageIfAvailable` expose the same resolve-first
behavior for other optional integrations. They only suppress a genuinely
missing package; initialization errors from an installed package still surface.

## Pyfig migration

Pyfig can keep `pyfigOptionsSchema` as its API source of truth. Its CLI only
needs to replace the manual Fireargs loader and five `f.option(...)` calls:

```ts
const { f, options: pyfigOptions } = await createOptionKit(pyfigOptionsSchema, {
  log,
  moduleUrl: import.meta.url,
});

const createInput = (passthrough = false) => z.object({
  ...pyfigOptions,
  ...(passthrough ? { args: f.argument().schema(passthroughArguments) } : {}),
});
```

The command, router, output schemas, handlers, and passthrough behavior do not
change. `PYFIG_*` names and `-u/-p/-d/-c/-e` flags are derived automatically.
After optionkit is published, Pyfig can depend on it and remove its direct
`@antfu/install-pkg` dependency and local loader. Pyfig should retain Fireargs
in `devDependencies` for typechecking and retain its optional peer metadata:

```json
{
  "peerDependencies": { "fireargs": "^0.6.2" },
  "peerDependenciesMeta": { "fireargs": { "optional": true } },
  "devDependencies": { "fireargs": "^0.6.2" }
}
```

Keeping the peer optional is important for packed and `bunx` execution: the
package advertises its CLI integration without making Fireargs a required
preinstalled peer, leaving optionkit's resolve-first loader free to populate
the isolated cache.

## Install

```sh
bun add optionkit
```

## License

MIT
