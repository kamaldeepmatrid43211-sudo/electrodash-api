import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';

import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { brands, categories, orderItems, orders, products, users } from '../src/db/schema.js';

let h: DbHandle;
let app: FastifyInstance;

async function detail(slug: string) {
  const res = await app.inject({ method: 'GET', url: `/v1/products/${slug}` });
  expect(res.statusCode).toBe(200);
  return res.json() as any;
}
const skus = (list: any[]) => list.map((p) => p.sku);

beforeAll(async () => {
  h = await openDb({ memory: true });
  app = await buildApp(h.db);
  const [wires, lamps] = await h.db
    .insert(categories)
    .values([
      { slug: 'wires', name: 'Wires' },
      { slug: 'lamps', name: 'Lamps' },
    ])
    .returning();
  const [finolex, havells, philips] = await h.db
    .insert(brands)
    .values([
      { slug: 'finolex', name: 'Finolex' },
      { slug: 'havells', name: 'Havells' },
      { slug: 'philips', name: 'Philips' },
    ])
    .returning();
  const base = { images: [] as string[], stockQty: 5, mrpPaise: 100_000 };
  // W0 is the product we open; W1..W11 sit in its category at various prices
  const wireRows = Array.from({ length: 12 }, (_, i) => ({
    ...base,
    sku: `W${i}`,
    slug: `w${i}`,
    name: `Wire ${i}`,
    categoryId: wires.id,
    brandId: i % 3 === 0 ? finolex.id : havells.id,
    pricePaise: 10_000 + i * 1_000,
    isBestseller: i === 11,
  }));
  const inserted = await h.db
    .insert(products)
    .values([
      ...wireRows,
      { ...base, sku: 'L1', slug: 'l1', name: 'Lamp 1', categoryId: lamps.id, brandId: philips.id, pricePaise: 50_000, isBestseller: true },
      { ...base, sku: 'L2', slug: 'l2', name: 'Lamp 2', categoryId: lamps.id, brandId: philips.id, pricePaise: 60_000 },
    ])
    .returning();
  const bySku = new Map(inserted.map((p) => [p.sku, p]));

  // one past order bought W0 together with L2
  const [u] = await h.db.insert(users).values({ phone: '+919800000001' }).returning();
  const [o] = await h.db
    .insert(orders)
    .values({
      number: 'ED-TEST-1',
      userId: u.id,
      address: { label: 'home', name: 'A', phone: '+919800000001', line1: '1', city: 'Mohali', state: 'Punjab', pincode: '140306' } as any,
      subtotalPaise: 70_000,
      mrpTotalPaise: 200_000,
      deliveryFeePaise: 0,
      handlingFeePaise: 0,
      totalPaise: 70_000,
      paymentMethod: 'cod',
      idempotencyKey: 'k1',
    })
    .returning();
  await h.db.insert(orderItems).values(
    ['W0', 'L2'].map((sku) => ({
      orderId: o.id,
      productId: bySku.get(sku)!.id,
      sku,
      name: sku,
      qty: 1,
      unitPricePaise: bySku.get(sku)!.pricePaise,
      unitMrpPaise: 100_000,
    })),
  );
});

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('product page sections', () => {
  it('splits the category into Similar (nearest price) and Top (most popular of the rest)', async () => {
    const d = await detail('w0');
    // the 9 nearest in price to W0 (₹100): W1..W9
    expect(skus(d.related)).toEqual(['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9']);
    // the rest, bestseller first
    expect(skus(d.topInCategory)).toEqual(['W11', 'W10']);
    expect(d.related.concat(d.topInCategory).some((p: any) => p.sku === 'W0')).toBe(false);
  });

  it('lists the brands in the category, most products first, with their logos', async () => {
    let d = await detail('w0');
    expect(d.brandsInCategory.map((b: any) => [b.slug, b.count])).toEqual([
      ['havells', 8],
      ['finolex', 4],
    ]);

    // a logo set from Wall2Roof (brands.logo_url) shows on the product and in the brands row
    await h.db.update(brands).set({ logoUrl: 'https://example.com/finolex.png' }).where(eq(brands.slug, 'finolex'));
    d = await detail('w0');
    expect(d.brandLogoUrl).toBe('https://example.com/finolex.png');
    expect(d.brandsInCategory.find((b: any) => b.slug === 'finolex').logoUrl).toBe('https://example.com/finolex.png');
    expect(d.brandsInCategory.find((b: any) => b.slug === 'havells').logoUrl).toBeNull();
  });

  it('puts products bought together first in "People also bought", then bestsellers from other categories', async () => {
    const d = await detail('w0');
    expect(skus(d.alsoBought)).toEqual(['L2', 'L1']);
    // a product nobody bought with anything: only the top-up, never its own category or itself
    const other = await detail('w5');
    expect(skus(other.alsoBought)).toEqual(['L1', 'L2']);
  });
});
