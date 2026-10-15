import { buildApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db/client.js';
import { startImageCopying } from './jobs/copy-images.js';
import { ImageStore } from './lib/images.js';

const { db, close } = await openDb();
const images = new ImageStore(config.imagesDir);
const app = await buildApp(db, {}, { images });

const shutdown = async () => {
  await app.close();
  await close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });

if (config.imageImport && config.publicUrl) {
  app.log.info({ dir: config.imagesDir, publicUrl: config.publicUrl }, 'copying outside images onto this server');
  startImageCopying(db, images, config.publicUrl, app.log);
} else {
  app.log.info({ dir: config.imagesDir, persistent: config.imagesPersistent }, 'image copying is off (needs a volume and a public https address)');
}
