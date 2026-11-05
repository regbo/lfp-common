import { startExampleWorker } from './stdio-worker.js';

const workerPromise = startExampleWorker();
const clientPromise = import('./client.js');
await using worker = await workerPromise;
const client = await clientPromise;
const connection = client.connectDemo(worker.clientOptions);
try {
  console.log('One request/response weather snapshot');
  console.table([await client.getWeather(connection, { location: 'Boston, MA' })]);

  console.log('Weather changes yielded by a Python async generator');
  for await (const change of client.watchWeather(connection, {
    interval: 0.1,
    location: 'Boston, MA',
    updates: 3,
  })) {
    console.log(change.summary);
  }

} finally {
  connection.close();
}
