import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PythonInfo } from './probes.js';
import { canonicalPath } from './python-venv.js';

export const VENV_SCHEMA = 1;
export const VENV_METADATA = '.pyfig-venv.json';

export interface VenvContract {
  schema: typeof VENV_SCHEMA;
  runtime: {
    architecture: string;
    platform: NodeJS.Platform;
  };
  python: {
    architecture: string;
    baseExecutable: string;
    basePrefix: string;
    embeddingHeader: string | null;
    embeddingLibrary: string | null;
    gilDisabled: boolean;
    implementation: string;
    pointerBits: number;
    version: string;
  };
  requirementsSha256: string;
}

export interface VenvIdentity {
  contract: VenvContract;
  directoryName: string;
  id: string;
}

interface VenvMetadata {
  contract: VenvContract;
  venvId: string;
}

/** Derive one stable venv identity from its interpreter and exact resolution. */
export function createVenvIdentity(
  python: PythonInfo,
  requirementsSha256: string,
): VenvIdentity {
  const contract: VenvContract = {
    schema: VENV_SCHEMA,
    runtime: {
      architecture: process.arch,
      platform: process.platform,
    },
    python: {
      architecture: python.architecture,
      baseExecutable: canonicalPath(python.executable),
      basePrefix: canonicalPath(python.basePrefix),
      embeddingHeader: python.embedding ? canonicalPath(python.embedding.headerPath) : null,
      embeddingLibrary: python.embedding ? canonicalPath(python.embedding.libraryPath) : null,
      gilDisabled: python.gilDisabled,
      implementation: python.implementation,
      pointerBits: python.pointerBits,
      version: python.version,
    },
    requirementsSha256,
  };
  const id = sha256(JSON.stringify(contract));
  const implementation = safePathSegment(python.implementation);
  const version = safePathSegment(python.version);
  return {
    contract,
    directoryName: `${implementation}-${version}-${id.slice(0, 20)}`,
    id,
  };
}

export function requirementsDigest(content: string): string {
  return sha256(content);
}

export function venvMetadataFile(directory: string): string {
  return path.join(directory, VENV_METADATA);
}

/** Metadata is the publication marker; an environment without it is incomplete. */
export async function venvMatches(
  directory: string,
  venv: VenvIdentity,
): Promise<boolean> {
  try {
    const parsed = JSON.parse(
      await readFile(venvMetadataFile(directory), 'utf8'),
    ) as VenvMetadata;
    return parsed.venvId === venv.id &&
      JSON.stringify(parsed.contract) === JSON.stringify(venv.contract);
  } catch {
    return false;
  }
}

/** Publish the venv marker atomically after creation and installation succeed. */
export async function writeVenvMetadata(
  directory: string,
  venv: VenvIdentity,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const file = venvMetadataFile(directory);
  const staged = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const metadata: VenvMetadata = {
    contract: venv.contract,
    venvId: venv.id,
  };
  try {
    await writeFile(staged, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(staged, file);
  } finally {
    await rm(staged, { force: true });
  }
}

function safePathSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9.-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'python';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
