import { buildApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db/client.js';

const { db, close } = await openDb();
const app = await buildApp(db);

const shutdown = async () => {
  await app.close();
  await close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
