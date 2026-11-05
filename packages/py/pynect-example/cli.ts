#!/usr/bin/env bun

import * as prompts from '@clack/prompts';
import { createOptionKit } from 'optionkit';
import {
  ChatPromptSchema,
  ChatTranscriptSchema,
  WeatherChangeSchema,
  WeatherQuerySchema,
  WeatherSnapshotSchema,
  WeatherWatchSchema,
  type ChatMessage,
  type ChatTranscript,
} from './_generated/pynect-example/index.js';
import type { DemoConnection } from './client.js';
import { startExampleWorker } from './stdio-worker.js';

type DemoClient = typeof import('./client.js');

export async function main(argv: string[] = process.argv): Promise<void> {
  const { f, z } = await createOptionKit({
    moduleUrl: import.meta.url,
    projectName: 'pynect-example',
  });
  const weatherInputSchema = WeatherQuerySchema.extend({
    location: WeatherQuerySchema.shape.location.describe('City or region to observe.'),
  }).readonly();
  const watchInputSchema = WeatherWatchSchema.extend({
    location: WeatherWatchSchema.shape.location.describe('City or region to observe.'),
    updates: WeatherWatchSchema.shape.updates.describe('Number of weather-change events to emit.'),
    interval: WeatherWatchSchema.shape.interval.describe('Delay between events in seconds.'),
  }).readonly();
  const chatInputSchema = z.object({
    message: ChatPromptSchema.shape.content.optional()
      .describe('Send one message and exit; omit to start an interactive chat.'),
    name: z.string().trim().min(1).max(60).optional()
      .describe('Display name shown by the interactive prompt.'),
  }).readonly();

  const weather = f.command({
    description: 'Request one weather snapshot from Python.',
    jsonOption: {},
  })
    .input(weatherInputSchema)
    .output(WeatherSnapshotSchema)
    .render(snapshot => { console.table([snapshot]); })
    .handler((query, context) => withIpcWorker(
      context.json,
      (client, connection) => client.getWeather(connection, query),
    ));

  let suppressBufferedStreamOutput = false;
  const watch = f.command({
    description: 'Consume generated weather-change events as Python yields them.',
    jsonOption: {},
    configureOutput: {
      writeOut: (value: string) => {
        if (!suppressBufferedStreamOutput) process.stdout.write(value);
      },
    },
  })
    .input(watchInputSchema)
    .output(z.array(WeatherChangeSchema))
    .render(changes => `Received ${changes.length} weather-change event${changes.length === 1 ? '' : 's'}`)
    .handler((options, context) => {
      // Fireargs serializes JSON after a handler; this command already emits
      // validated NDJSON incrementally, so suppress only that buffered copy.
      suppressBufferedStreamOutput = context.json;
      return withIpcWorker(context.json, async (client, connection) => {
        const changes = [];
        for await (const change of client.watchWeather(connection, options)) {
          changes.push(change);
          if (context.json) process.stdout.write(`${JSON.stringify(change)}\n`);
          else console.table([{
            sequence: change.sequence,
            location: change.weather.location,
            temperature_c: change.weather.temperature_c,
            condition: change.weather.condition,
            humidity_percent: change.weather.humidity_percent,
          }]);
        }
        return changes;
      });
    });

  let suppressInteractiveChatOutput = false;
  const chat = f.command({
    description: 'Chat with a local SmolLM2 model using Python-owned conversation state.',
    jsonOption: {},
  })
    .input(chatInputSchema)
    .output(ChatTranscriptSchema)
    .render(transcript => {
      if (suppressInteractiveChatOutput) return undefined;
      return lastAssistantMessage(transcript)?.content;
    })
    .handler((input, context) => {
      if (context.json && input.message === undefined) {
        throw new Error('--json requires --message because interactive terminal output is not JSON.');
      }
      suppressInteractiveChatOutput = input.message === undefined;
      if (input.message === undefined) {
        prompts.intro('Pynect local chat');
        prompts.note('Enter /exit or /quit to leave.', 'Session');
      }
      return withIpcWorker(context.json, async (client, connection) => {
        if (input.message !== undefined) {
          return client.chat(connection, { content: input.message });
        }
        return interactiveChat(client, connection, input.name, prompts);
      }, true);
    });

  const program = f.program({
    name: 'pynect-example',
    description: 'Run weather, event-stream, and local-model chat examples through owned stdio IPC.',
  }).router({
    weather,
    'watch-weather': watch,
    chat,
  });

  await program.parseAsync(argv);
}

async function interactiveChat(
  client: DemoClient,
  connection: DemoConnection,
  name: string | undefined,
  clack: typeof prompts,
): Promise<ChatTranscript> {
  const displayName = name ?? 'You';
  let transcript: ChatTranscript = { messages: [], turn: 0 };

  while (true) {
    const input = await clack.text({
      message: `${displayName}:`,
      placeholder: 'Ask the local model something',
      validate: value => value?.trim() ? undefined : 'Enter a message or /exit.',
    });
    if (clack.isCancel(input)) {
      clack.cancel(`Chat ended after ${transcript.turn} turn${transcript.turn === 1 ? '' : 's'}.`);
      return transcript;
    }

    const message = input.trim();
    if (message === '/exit' || message === '/quit') {
      clack.outro(`Chat ended after ${transcript.turn} turn${transcript.turn === 1 ? '' : 's'}.`);
      return transcript;
    }

    transcript = await client.chat(connection, { content: message });
    clack.log.info(lastAssistantMessage(transcript)?.content ?? 'The model returned no assistant message.');
  }
}

function lastAssistantMessage(transcript: ChatTranscript): ChatMessage | undefined {
  for (let index = transcript.messages.length - 1; index >= 0; index -= 1) {
    const message = transcript.messages[index];
    if (message?.role === 'assistant') return message;
  }
  return undefined;
}

async function withIpcWorker<Result>(
  json: boolean,
  run: (client: DemoClient, connection: DemoConnection) => Promise<Result>,
  preloadChat = false,
): Promise<Result> {
  const workerPromise = startExampleWorker({
    preloadChat,
    stdout: json ? process.stderr : process.stdout,
  });
  const clientPromise = import('./client.js');
  await using worker = await workerPromise;
  if (preloadChat) await worker.ready;
  const client = await clientPromise;
  const connection = client.connectDemo(worker.clientOptions);
  const modelReady = preloadChat ? Promise.withResolvers<void>() : undefined;
  const loading = preloadChat && !json ? prompts.spinner() : undefined;
  let loadingStarted = false;
  const stopStatus = preloadChat
    ? client.onChatStatus(connection, status => {
        if (loading) {
          if (!loadingStarted) {
            loading.start(status.message);
            loadingStarted = true;
          } else if (status.stage === 'ready') {
            loading.stop(status.message);
          } else if (status.stage === 'error') {
            loading.error(status.message);
          } else {
            loading.message(status.message);
          }
        }
        if (status.stage === 'ready') modelReady?.resolve();
        else if (status.stage === 'error') modelReady?.reject(new Error(status.message));
      })
    : undefined;
  try {
    await modelReady?.promise;
    return await run(client, connection);
  } finally {
    stopStatus?.();
    connection.close();
  }
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
