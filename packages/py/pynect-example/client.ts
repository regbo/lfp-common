import type { ClientOptions } from '@chanx-js/client';
import {
  createPynectClient,
  demo,
  type ChatModelStatus,
  type ChatPrompt,
  type ChatTranscript,
  type WeatherChange,
  type WeatherQuery,
  type WeatherSnapshot,
  type WeatherWatch,
} from './_generated/pynect-example/index.js';

export function connectDemo(options: ClientOptions) {
  return createPynectClient(options).connect(demo);
}

export type DemoConnection = ReturnType<typeof connectDemo>;

export function onChatStatus(
  connection: DemoConnection,
  listener: (status: ChatModelStatus) => void,
): () => void {
  return connection.onAny(message => {
    if (message.action === 'chat_status') listener(message.payload);
  });
}

export async function getWeather(
  connection: DemoConnection,
  query: WeatherQuery = { location: 'New York, NY' },
): Promise<WeatherSnapshot> {
  await connection.ready({ timeout: 5_000 });
  const result = await connection.request({
    action: 'get_weather',
    payload: query,
  });
  return result.payload;
}

export async function* watchWeather(
  connection: DemoConnection,
  options: WeatherWatch = {
    interval: 0.25,
    location: 'New York, NY',
    updates: 5,
  },
): AsyncGenerator<WeatherChange> {
  await connection.ready({ timeout: 5_000 });
  const result = connection.request({
    action: 'watch_weather',
    payload: options,
  });
  for await (const response of result) yield response.payload;
}

export async function chat(
  connection: DemoConnection,
  prompt: ChatPrompt,
): Promise<ChatTranscript> {
  await connection.ready({ timeout: 300_000 });
  const result = await connection.request({
    action: 'chat',
    payload: prompt,
  }, { timeout: 300_000 });
  return result.payload;
}
