import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { hash } from "ohash";
import { readPackageUp } from "read-package-up";
import type { ResolvedLockOptionsData } from "./schemas.js";

const namespaceCache = new Map<string, Promise<string>>();

async function discoverNamespace(cwd: string): Promise<string> {
  const packageResult = await readPackageUp({ cwd });
  const packageName = packageResult?.packageJson.name;

  if (typeof packageName === "string" && packageName.length > 0) {
    return packageName;
  }

  return basename(resolve(cwd)) || "default";
}

async function resolveNamespace(
  options: ResolvedLockOptionsData,
): Promise<string> {
  if (options.namespace) return options.namespace;

  const environmentNamespace = process.env.LOQKIT_NAMESPACE?.trim();
  if (environmentNamespace) return environmentNamespace;

  const cwd = resolve(options.cwd);
  let pending = namespaceCache.get(cwd);
  if (!pending) {
    pending = discoverNamespace(cwd);
    namespaceCache.set(cwd, pending);
  }

  return pending;
}

function resolveLockDirectory(options: ResolvedLockOptionsData): string {
  const configured =
    options.lockDirectory ??
    process.env.LOQKIT_LOCK_DIR?.trim() ??
    join(tmpdir(), "loqkit");

  return isAbsolute(configured) ? configured : resolve(options.cwd, configured);
}

export async function createLockIdentity(
  context: object,
  options: ResolvedLockOptionsData,
): Promise<{
  id: string;
  name: string;
  namespace: string;
  fileBase: string;
}> {
  const namespace = await resolveNamespace(options);
  const id = hash({ namespace, key: options.key ?? context });
  const name = options.name ?? id.slice(0, 12);
  const namespaceDirectory = hash(namespace).slice(0, 12);
  const fileBase = join(resolveLockDirectory(options), namespaceDirectory, id);

  return { id, name, namespace, fileBase };
}
