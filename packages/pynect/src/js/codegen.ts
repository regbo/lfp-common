import { mkdir, readFile } from 'node:fs/promises';
import { generate, type AsyncAPIDocument, type GenerateResult } from '@chanx-js/codegen';
import { resolveProject, type PynectProject, type ProjectOptions } from './config.js';
import { spawnWorker, waitForChild } from './python-runtime.js';
import { emitStreamHelpers } from './stream-codegen.js';

export interface PynectGenerateResult extends GenerateResult {
  readonly outDir: string;
  readonly schemaPath: string;
}

/** Export AsyncAPI from Python, then generate the normal Chanx TypeScript client. */
export async function generateProject(
  input: ProjectOptions = {},
): Promise<PynectGenerateResult> {
  const project = resolveProject(input);
  await mkdir(project.outDir, { recursive: true });
  await exportSchema(project);
  const document = JSON.parse(await readFile(project.schemaPath, 'utf8')) as AsyncAPIDocument;
  const result = await generate(document, {
    outDir: project.outDir,
    validation: project.validation,
    emit: 'ts',
    format: project.format,
  });
  const streamsPath = await emitStreamHelpers(document, project.outDir);
  return Object.freeze({
    ...result,
    files: [...result.files, streamsPath],
    outDir: project.outDir,
    schemaPath: project.schemaPath,
  });
}

async function exportSchema(project: PynectProject): Promise<void> {
  const { child } = await spawnWorker(
    project,
    ['-c', 'from pynect_worker.schema import main; main()'],
    {
    env: {
      PYNECT_APP: project.app,
      PYNECT_SCHEMA_PATH: project.schemaPath,
      PYTHONUNBUFFERED: '1',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
  await waitForChild(child, 'Python schema export');
}
