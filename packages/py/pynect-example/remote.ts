import {
  chat,
  connectDemo,
  getWeather,
  onChatStatus,
  watchWeather,
} from './client.js';

const connection = connectDemo({
  baseUrl: process.env.CHANX_BASE_URL ?? 'ws://127.0.0.1:7777',
});
const stopStatus = onChatStatus(connection, status => { console.log(status.message); });
try {
  console.log('One request/response weather snapshot');
  console.table([await getWeather(connection, { location: 'Seattle, WA' })]);

  console.log('Weather changes over a remote WebSocket');
  for await (const change of watchWeather(connection, {
    interval: 0.1,
    location: 'Seattle, WA',
    updates: 3,
  })) {
    console.log(change.summary);
  }

  console.log(await chat(connection, { content: 'Reply with one short hello.' }));
} finally {
  stopStatus();
  connection.close();
}
