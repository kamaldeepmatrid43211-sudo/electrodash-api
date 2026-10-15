import type { FastifyBaseLogger } from 'fastify';
import { and, eq, isNotNull, notLike, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { banners, brands, categories, orderItems, products } from '../db/schema.js';
import { downloadImage, type ImageStore } from '../lib/images.js';

export type CopyReport = { copied: number; rowsUpdated: number; failed: { url: string; reason: string }[] };

/**
 * Copy every image that still lives on another website (product photos, category pictures,
 * banners, brand logos, pictures on past orders) onto this server and point the database at the
 * copy, so the app no longer breaks when those websites change or delete a picture.
 *
 * Safe to run any time: images already on this server are skipped, the same picture is stored
 * only once, and a link that can't be copied is left as it is and tried again next time.
 * `updated_at` is left alone, so the admin's "recently changed" order isn't disturbed.
 */
export async function copyOutsideImages(db: Db, store: ImageStore, baseUrl: string, opts: { allowPrivate?: boolean } = {}): Promise<CopyReport> {
  const prefix = `${baseUrl}/img/`;
  const ours = (u: string) => u.startsWith(prefix);
  const report: CopyReport = { copied: 0, rowsUpdated: 0, failed: [] };
  const done = new Map<string, string | null>(); // outside link → our link (null = failed this run)

  const copy = async (url: string | null): Promise<string | null> => {
    if (!url || ours(url) || !/^https?:\/\//i.test(url)) return url;
    if (!done.has(url)) {
      try {
        const name = await store.save(await downloadImage(url, opts));
        done.set(url, prefix + name);
        report.copied++;
      } catch (e) {
        done.set(url, null);
        report.failed.push({ url, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return done.get(url) ?? url;
  };

  // Product photos (a list per product): only products with at least one outside photo.
  const outside = sql`exists (select 1 from jsonb_array_elements_text(${products.images}) u where u not like ${`${prefix}%`})`;
  for (const p of await db.select({ id: products.id, images: products.images }).from(products).where(outside)) {
    const next: string[] = [];
    for (const u of p.images) next.push((await copy(u)) ?? u);
    if (next.some((u, i) => u !== p.images[i])) {
      await db.update(products).set({ images: next }).where(eq(products.id, p.id));
      report.rowsUpdated++;
    }
  }

  // Single picture columns.
  const single = async (rows: { id: number; url: string | null }[], save: (id: number, url: string) => Promise<unknown>) => {
    for (const r of rows) {
      const next = await copy(r.url);
      if (next && next !== r.url) {
        await save(r.id, next);
        report.rowsUpdated++;
      }
    }
  };
  const like = `${prefix}%`;
  await single(
    await db.select({ id: categories.id, url: categories.imageUrl }).from(categories).where(and(isNotNull(categories.imageUrl), notLike(categories.imageUrl, like))),
    (id, url) => db.update(categories).set({ imageUrl: url }).where(eq(categories.id, id)),
  );
  await single(
    await db.select({ id: banners.id, url: banners.imageUrl }).from(banners).where(notLike(banners.imageUrl, like)),
    (id, url) => db.update(banners).set({ imageUrl: url }).where(eq(banners.id, id)),
  );
  await single(
    await db.select({ id: brands.id, url: brands.logoUrl }).from(brands).where(and(isNotNull(brands.logoUrl), notLike(brands.logoUrl, like))),
    (id, url) => db.update(brands).set({ logoUrl: url }).where(eq(brands.id, id)),
  );
  await single(
    await db.select({ id: orderItems.id, url: orderItems.image }).from(orderItems).where(and(isNotNull(orderItems.image), notLike(orderItems.image, like))),
    (id, url) => db.update(orderItems).set({ image: url }).where(eq(orderItems.id, id)),
  );

  return report;
}

/**
 * Run the copy shortly after start and then every 10 minutes, so products the admin pushes and
 * banners it uploads are copied without anyone doing anything.
 */
export function startImageCopying(db: Db, store: ImageStore, baseUrl: string, log: FastifyBaseLogger, everyMs = 10 * 60_000) {
  let running = false;
  let lastFailed = -1;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await copyOutsideImages(db, store, baseUrl);
      // stay quiet when nothing happened, and don't repeat the same failures every 10 minutes
      if (r.copied || r.rowsUpdated || r.failed.length !== lastFailed) {
        log.info({ copied: r.copied, rowsUpdated: r.rowsUpdated, failed: r.failed.slice(0, 20) }, 'image copy');
      }
      lastFailed = r.failed.length;
    } catch (e) {
      log.error(e, 'image copy failed');
    } finally {
      running = false;
    }
  };
  setTimeout(run, 15_000).unref();
  setInterval(run, everyMs).unref();
}
