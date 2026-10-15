import cors from '@fastify/cors';
import Fastify, { type FastifyServerOptions } from 'fastify';

import { config } from './config.js';
import type { Db } from './db/client.js';
import { HttpError, readAuth, sendError } from './http.js';
import { ImageStore } from './lib/images.js';
import { accountRoutes } from './routes/account.js';
import { authRoutes } from './routes/auth.js';
import { cartRoutes } from './routes/cart.js';
import { catalogRoutes } from './routes/catalog.js';
import { imageRoutes } from './routes/images.js';
import { integrationRoutes } from './routes/integration.js';
import { orderRoutes } from './routes/orders.js';

export type AppDeps = {
  /** Wall2Roof admin integration key; defaults to WALL2ROOF_ADMIN_KEY. */
  integrationKey?: string | null;
  /** The server's own image copies; defaults to IMAGES_DIR / the Railway volume. */
  images?: ImageStore;
};

export async function buildApp(db: Db, opts: FastifyServerOptions = {}, deps: AppDeps = {}) {
  const app = Fastify({
    logger: config.isTest
      ? false
      : {
          level: config.isProd ? 'info' : 'debug',
          // Never log credentials, tokens or integration keys.
          redact: ['req.headers.authorization', 'req.body.password', 'req.body.refreshToken', 'req.body.code'],
        },
    trustProxy: true,
    bodyLimit: 256 * 1024,
    ...opts,
  });

  // Native apps don't use CORS; browsers (web preview, admin panel) do.
  await app.register(cors, {
    origin: config.CORS_ORIGINS === '*' ? true : config.CORS_ORIGINS.split(','),
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });

  app.decorateRequest('auth', null);
  app.addHook('onRequest', readAuth);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return sendError(reply, err);
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({ error: { code: 'bad_request', message: 'The request was not valid.' } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'server_error', message: 'Something went wrong. Please try again.' } });
  });

  // `images` says whether copies are kept on a lasting disk and outside images are being copied.
  app.get('/health', async () => ({ ok: true, images: { persistent: config.imagesPersistent, copying: config.imageImport } }));

  await imageRoutes(app, { store: deps.images ?? new ImageStore(config.imagesDir) });
  await catalogRoutes(app, { db });
  await authRoutes(app, { db });
  await cartRoutes(app, { db });
  await orderRoutes(app, { db });
  await accountRoutes(app, { db });
  await integrationRoutes(app, { db, key: 'integrationKey' in deps ? deps.integrationKey : config.WALL2ROOF_ADMIN_KEY });

  return app;
}
