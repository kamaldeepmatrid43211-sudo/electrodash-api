import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';

import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { categories, productCategories, products } from '../src/db/schema.js';

const KEY = 'test-integration-key-0123456789-abcdefghij';
let h: DbHandle;
let app: FastifyInstance;
const cat: Record<string, number> = {};

async function call(method: string, url: string, body?: unknown) {
  const res = await app.inject({ method: method as 'GET', url, payload: body as object | undefined, headers: { authorization: `Bearer ${KEY}` } });
  return { status: res.statusCode, body: res.json() as any };
}

const skus = (body: any) => body.items.map((p: any) => p.sku).sort();

/** A product as Wall2Roof's /api/v1/products returns it (only what the push needs). */
function w2r(sku: string) {
  return {
    id: 2001,
    sku,
    name: 'Havells 1.5 sq mm Wire',
    brand: { id: 9, name: 'Havells' },
    active: true,
    price: 1500,
    special_price: null,
    mrp: 1800,
    images: [],
    attributes: [],
    store: { enabled: true, call_for_price: false, in_stock: true, qty: 5, categories: [] },
    updated_at: '2026-10-16 10:00:00',
  };
}

beforeAll(async () => {
  h = await openDb({ memory: true });
  app = await buildApp(h.db, {}, { integrationKey: KEY });
  const [lighting] = await h.db.insert(categories).values({ slug: 'lighting', name: 'Lighting', sort: 0 }).returning();
  const rows = await h.db
    .insert(categories)
    .values([
      { slug: 'ceiling', name: 'Ceiling', parentId: lighting.id, sort: 1 },
      { slug: 'wall', name: 'Wall', parentId: lighting.id, sort: 2 },
      { slug: 'wires', name: 'Wires', sort: 3 },
    ])
    .returning();
  cat.lighting = lighting.id;
  for (const r of rows) cat[r.slug] = r.id;

  const base = { images: [] as string[], stockQty: 5, pricePaise: 10_000, mrpPaise: 12_000 };
  const [p1, , p3] = await h.db
    .insert(products)
    .values([
      // main Ceiling, also listed under Wall
      { ...base, sku: 'P1', slug: 'p1', name: 'Dual lamp', categoryId: cat.ceiling },
      // main Wall, written by something that only sets category_id (no product_categories row)
      { ...base, sku: 'P2', slug: 'p2', name: 'Wall lamp', categoryId: cat.wall },
      { ...base, sku: 'P3', slug: 'p3', name: 'Wire', categoryId: cat.wires },
    ])
    .returning();
  await h.db.insert(productCategories).values([
    { productId: p1.id, categoryId: cat.ceiling },
    { productId: p1.id, categoryId: cat.wall },
    { productId: p3.id, categoryId: cat.wires },
  ]);
});

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('products in several categories', () => {
  it('shows a product in each of its categories, counting it once per parent', async () => {
    const list = (await call('GET', '/v1/categories')).body.categories;
    const lighting = list.find((c: any) => c.slug === 'lighting');
    expect(lighting.totalCount).toBe(2); // P1 sits in both sub-categories but is one product
    expect(lighting.children.map((c: any) => [c.slug, c.productCount, c.totalCount])).toEqual([
      ['ceiling', 1, 1],
      ['wall', 2, 2],
    ]);
    expect(list.find((c: any) => c.slug === 'wires')).toMatchObject({ productCount: 1, totalCount: 1 });

    expect(skus((await call('GET', '/v1/products?category=wall')).body)).toEqual(['P1', 'P2']);
    expect(skus((await call('GET', '/v1/products?category=ceiling')).body)).toEqual(['P1']);
    const all = (await call('GET', '/v1/products?category=lighting')).body;
    expect(skus(all)).toEqual(['P1', 'P2']);
    expect(all.total).toBe(2);
  });

  it('sets, keeps and clears categories through the Wall2Roof push', async () => {
    const put = (body: Record<string, unknown>) => call('PUT', '/v1/integration/products/W-1', { product: w2r('W-1'), ...body });
    const listed = async () => (await call('GET', '/v1/integration/products?q=W-1')).body.data[0];

    // first = main; duplicates dropped
    expect((await put({ category_ids: [cat.wires, cat.ceiling, cat.wires] })).status).toBe(200);
    expect(await listed()).toMatchObject({ category: { id: cat.wires }, category_ids: [cat.wires, cat.ceiling] });
    expect(skus((await call('GET', '/v1/products?category=ceiling')).body)).toEqual(['P1', 'W-1']);

    // leaving both out keeps them
    await put({});
    expect((await listed()).category_ids).toEqual([cat.wires, cat.ceiling]);

    // the products filter matches any of a product's categories
    expect((await call('GET', `/v1/integration/products?category_id=${cat.ceiling}`)).body.data.map((p: any) => p.sku).sort()).toEqual(['P1', 'W-1']);

    // category_id alone keeps its old meaning: just that one category
    await put({ category_id: cat.wall });
    expect(await listed()).toMatchObject({ category: { id: cat.wall }, category_ids: [cat.wall] });

    // an unknown id is refused, naming it, and nothing changes
    const bad = await put({ category_ids: [cat.ceiling, 999_999] });
    expect(bad).toMatchObject({ status: 422, body: { error: "Category 999999 doesn't exist." } });
    expect((await listed()).category_ids).toEqual([cat.wall]);

    // an empty list clears them
    await put({ category_ids: [] });
    expect(await listed()).toMatchObject({ category: null, category_ids: [] });
    const [row] = await h.db.select().from(products).where(eq(products.sku, 'W-1'));
    expect(row.categoryId).toBeNull();

    expect((await put({ category_ids: Array.from({ length: 11 }, (_, i) => i + 1) })).status).toBe(422);
  });
});
