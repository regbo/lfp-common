# cfgkit

`cfgkit` resolves typed Node.js configuration from defaults, environment
variables, and long CLI flags.

```js
import { loadConfig } from "cfgkit";

const config = loadConfig({
  defaults: {
    port: 3000,
    debug: false,
    logLevel: "info",
  },
  prefix: "MY_APP_",
});
```

With `MY_APP_PORT=4000` and `node app.js --port=5000 --debug`, the result is:

```js
{
  port: 5000,
  debug: true,
  logLevel: "info",
}
```

Precedence is `defaults < environment < CLI`. Camel-case keys map to
upper-snake-case environment names (`logLevel` becomes `MY_APP_LOG_LEVEL`) and
kebab-case CLI flags (`--log-level`). Boolean flags accept `--debug` and
`--no-debug`.

## Install

```sh
bun add cfgkit
```

## License

MIT
