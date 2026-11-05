import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  analyze,
  camelCase,
  type AsyncAPIDocument,
  type OperationObject,
} from '@chanx-js/codegen';

type StreamOperation = OperationObject & {
  readonly 'x-pynect-stream'?: boolean;
};

/** Add iterator metadata and Pynect's client to generated Chanx modules. */
export async function emitStreamSupport(
  document: AsyncAPIDocument,
  outDir: string,
): Promise<void> {
  const streams = streamSpecs(document);
  await markStreamChannels(path.join(outDir, 'channels.ts'), streams);
  await rm(path.join(outDir, 'streams.ts'), { force: true });

  const indexPath = path.join(outDir, 'index.ts');
  const index = await readFile(indexPath, 'utf8');
  const clientExport = "export { createPynectClient } from 'pynect';";
  if (!index.includes(clientExport)) {
    await writeFile(indexPath, `${index.trimEnd()}\n${clientExport}\n`, 'utf8');
  }
}

function streamSpecs(document: AsyncAPIDocument) {
  const connections = analyze(document);
  return Object.entries(document.operations ?? {}).flatMap(([name, rawOperation]) => {
    const operation = rawOperation as StreamOperation;
    if (operation['x-pynect-stream'] !== true) return [];

    const channelKey = referenceName(operation.channel?.$ref, `stream operation ${name} channel`);
    const connection = connections.find(candidate => candidate.key === channelKey);
    if (!connection) throw new Error(`Streaming operation ${name} has no generated channel.`);
    const requestType = messageSchemaName(
      document,
      operation.messages?.[0]?.$ref,
      `stream operation ${name} request`,
    );
    if ((operation.reply?.messages ?? []).length === 0) {
      throw new Error(`Streaming operation ${name} must declare at least one reply message.`);
    }
    return [{
      channel: camelCase(connection.name),
      requestAction: messageAction(document, requestType),
    }];
  });
}

type StreamSpec = ReturnType<typeof streamSpecs>[number];

async function markStreamChannels(
  channelsPath: string,
  streams: readonly StreamSpec[],
): Promise<void> {
  if (streams.length === 0) return;
  let channels = await readFile(channelsPath, 'utf8');
  const newline = channels.includes('\r\n') ? '\r\n' : '\n';
  const actionsByChannel = new Map<string, string[]>();
  for (const stream of streams) {
    const actions = actionsByChannel.get(stream.channel) ?? [];
    actions.push(stream.requestAction);
    actionsByChannel.set(stream.channel, actions);
  }
  const enhancedChannels: string[] = [];
  for (const [channel, actions] of actionsByChannel) {
    const declaration = `export const ${channel} =`;
    if (!channels.includes(declaration)) {
      throw new Error(`Generated stream channel ${channel} was not declared.`);
    }
    channels = channels.replace(declaration, `const ${channel}Channel =`);
    enhancedChannels.push(
      `export const ${channel} = Object.assign(${channel}Channel, {`,
      `  streamActions: [${actions.map(quote).join(', ')}] as const,`,
      '});',
      '',
    );
  }
  const channelsObject = 'export const channels = {';
  if (!channels.includes(channelsObject)) {
    throw new Error('Generated channels object was not declared.');
  }
  channels = channels.replace(
    channelsObject,
    `${enhancedChannels.join(newline)}${newline}${channelsObject}`,
  );
  await writeFile(channelsPath, channels, 'utf8');
}

function messageSchemaName(
  document: AsyncAPIDocument,
  messageReference: string | undefined,
  context: string,
): string {
  const messageName = referenceName(messageReference, context);
  const schemaReference = document.components?.messages?.[messageName]?.payload?.$ref;
  return referenceName(schemaReference, `${context} schema`);
}

function referenceName(reference: string | undefined, context: string): string {
  const name = reference?.split('/').at(-1);
  if (!name) throw new Error(`${context} is missing a reference.`);
  return name;
}

function messageAction(document: AsyncAPIDocument, schemaName: string): string {
  const action = document.components?.schemas?.[schemaName]?.properties?.action?.const;
  if (typeof action !== 'string') {
    throw new Error(`Streaming message ${schemaName} must have a constant string action.`);
  }
  return action;
}

function quote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}
