import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { banners, brands, categories, orderItems, orders, products, users } from '../src/db/schema.js';
import { copyOutsideImages } from '../src/jobs/copy-images.js';
import { downloadImage, ImageStore } from '../src/lib/images.js';

const BASE = 'https://api.test';
let h: DbHandle;
let app: FastifyInstance;
let store: ImageStore;
let dir: string;
let site: Server;
let web: string; // the "other website" the images come from

beforeAll(async () => {
  const png = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#3366cc' } }).png().toBuffer();
  const jpg = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#cc6633' } }).jpeg().toBuffer();
  site = createServer((req, res) => {
    if (req.url === '/a.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(png);
    if (req.url === '/b.jpg') return res.writeHead(200, { 'content-type': 'image/jpeg' }).end(jpg);
    if (req.url === '/moved') return res.writeHead(302, { location: '/a.png' }).end();
    if (req.url === '/page') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html>not a picture</html>');
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => site.listen(0, '127.0.0.1', ok));
  web = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

  dir = await mkdtemp(join(tmpdir(), 'ed-images-'));
  store = new ImageStore(dir);
  h = await openDb({ memory: true });
  app = await buildApp(h.db, {}, { images: store, integrationKey: null });
});

afterAll(async () => {
  await app.close();
  await h.close();
  await new Promise((ok) => site.close(ok));
  await rm(dir, { recursive: true, force: true });
});

describe('own image copies', () => {
  it('copies outside images, points the database at the copies, and keeps links it could not copy', async () => {
    const [br] = await h.db.insert(brands).values({ slug: 'philips', name: 'Philips', logoUrl: `${web}/b.jpg` }).returning();
    const [cat] = await h.db.insert(categories).values({ slug: 'lights', name: 'Lights', imageUrl: `${web}/a.png` }).returning();
    const [p] = await h.db
      .insert(products)
      .values({
        sku: 'L1', slug: 'lamp', name: 'Lamp', brandId: br.id, categoryId: cat.id, pricePaise: 100, mrpPaise: 100, stockQty: 1,
        images: [`${web}/a.png`, `${web}/moved`, `${web}/page`, `${web}/missing.jpg`, `${BASE}/img/already-ours.png`],
      })
      .returning();
    const [bn] = await h.db.insert(banners).values({ title: 'Sale', imageUrl: `${web}/b.jpg` }).returning();
    const [u] = await h.db.insert(users).values({ phone: '+919876543210' }).returning();
    const [o] = await h.db
      .insert(orders)
      .values({
        number: 'ED-T-1', userId: u.id, address: {} as never, subtotalPaise: 100, mrpTotalPaise: 100, deliveryFeePaise: 0,
        handlingFeePaise: 0, totalPaise: 100, paymentMethod: 'cod', idempotencyKey: 'test-key-1',
      })
      .returning();
    const [oi] = await h.db
      .insert(orderItems)
      .values({ orderId: o.id, productId: p.id, sku: 'L1', name: 'Lamp', image: `${web}/a.png`, qty: 1, unitPricePaise: 100, unitMrpPaise: 100 })
      .returning();

    const r = await copyOutsideImages(h.db, store, BASE, { allowPrivate: true });
    // 3 different links (a.png, /moved → a.png, b.jpg — shared by the banner and the brand) but only 2 pictures
    expect(r.copied).toBe(3);
    expect(r.failed.map((f) => f.url).sort()).toEqual([`${web}/missing.jpg`, `${web}/page`]);
    expect((await readdir(dir)).filter((f) => !f.startsWith('w')).length).toBe(2);

    const mine = expect.stringMatching(/^https:\/\/api\.test\/img\/[a-f0-9]{32}\.(png|jpg)$/);
    const [prod] = await h.db.select().from(products).where(eq(products.id, p.id));
    expect(prod.images).toEqual([mine, mine, `${web}/page`, `${web}/missing.jpg`, `${BASE}/img/already-ours.png`]);
    expect(prod.images[0]).toBe(prod.images[1]); // same picture → same copy
    expect((await h.db.select().from(categories).where(eq(categories.id, cat.id)))[0].imageUrl).toEqual(mine);
    expect((await h.db.select().from(banners).where(eq(banners.id, bn.id)))[0].imageUrl).toEqual(mine);
    expect((await h.db.select().from(brands).where(eq(brands.id, br.id)))[0].logoUrl).toEqual(mine);
    expect((await h.db.select().from(orderItems).where(eq(orderItems.id, oi.id)))[0].image).toEqual(mine);

    // running again only retries what failed
    const again = await copyOutsideImages(h.db, store, BASE, { allowPrivate: true });
    expect(again.copied).toBe(0);
    expect(again.rowsUpdated).toBe(0);
    expect(again.failed.length).toBe(2);
  });

  it('serves the original and smaller WebP versions, cached for a year', async () => {
    const name = await store.save(await sharp({ create: { width: 800, height: 600, channels: 3, background: '#000' } }).png().toBuffer());

    const orig = await app.inject({ url: `/img/${name}` });
    expect(orig.statusCode).toBe(200);
    expect(orig.headers['content-type']).toBe('image/png');
    expect(orig.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    const small = await app.inject({ url: `/img/${name}?w=300` });
    expect(small.headers['content-type']).toBe('image/webp');
    expect(await sharp(small.rawPayload).metadata()).toMatchObject({ format: 'webp', width: 320 }); // snapped up to 320

    const big = await app.inject({ url: `/img/${name}?w=5000` });
    expect((await sharp(big.rawPayload).metadata()).width).toBe(800); // never enlarged

    for (const bad of [`/img/${'0'.repeat(32)}.png`, '/img/abc.png', '/img/..%2F..%2Fetc%2Fpasswd', `/img/${name.replace('.png', '.svg')}`]) {
      expect((await app.inject({ url: bad })).statusCode).toBe(404);
    }
  });

  it('refuses links into private networks and things that are not pictures', async () => {
    await expect(downloadImage(`${web}/a.png`)).rejects.toThrow('private address');
    await expect(downloadImage('http://localhost:5432/x.png')).rejects.toThrow('private address');
    await expect(downloadImage('http://postgres.railway.internal/x.png')).rejects.toThrow('private address');
    await expect(downloadImage('ftp://example.com/x.png')).rejects.toThrow('only http(s)');
    await expect(store.save(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).rejects.toThrow();
  });
});
