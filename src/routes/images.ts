import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';

import { HttpError } from '../http.js';
import { CONTENT_TYPE, type ImageStore, NAME_RE, WIDTHS } from '../lib/images.js';

/**
 * The server's own images. `/img/<name>` is the original; `/img/<name>?w=320` a WebP at most
 * that wide (snapped up to the next standard width). Names come from the picture's content, so
 * an address never changes what it shows and phones may keep it for a year.
 */
export async function imageRoutes(app: FastifyInstance, { store }: { store: ImageStore }) {
  app.get('/img/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!NAME_RE.test(name)) throw new HttpError(404, 'not_found', 'No such image.');
    const want = Number((req.query as { w?: string }).w);

    let file: string | null;
    let type: string;
    if (Number.isFinite(want) && want > 0) {
      file = await store.sized(name, WIDTHS.find((w) => w >= want) ?? WIDTHS[WIDTHS.length - 1]);
      type = 'image/webp';
    } else {
      file = (await store.has(name)) ? store.path(name) : null;
      type = CONTENT_TYPE[name.split('.')[1]];
    }
    if (!file) throw new HttpError(404, 'not_found', 'No such image.');

    return reply.header('cache-control', 'public, max-age=31536000, immutable').type(type).send(createReadStream(file));
  });
}
