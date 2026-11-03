export type ConfigValue = string | number | boolean;

export interface LoadConfigOptions<T extends Record<string, ConfigValue>> {
  defaults: T;
  env?: Readonly<Record<string, string | undefined>>;
  argv?: readonly string[];
  prefix?: string;
}

/**
 * Resolves configuration using defaults, environment variables, and CLI flags,
 * in increasing order of precedence.
 */
export declare function loadConfig<T extends Record<string, ConfigValue>>(
  options: LoadConfigOptions<T>,
): T;
