import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';

import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { brands, categories, products } from '../src/db/schema.js';
import { mapWall2RoofProduct } from '../src/routes/integration.js';

const KEY = 'test-integration-key-0123456789-abcdefghij';
let h: DbHandle;
let app: FastifyInstance;
let bulbsId: number;
let lightingId: number;

async function call(method: string, url: string, body?: unknown, key: string | null = KEY, target = app) {
  const res = await target.inject({
    method: method as 'GET',
    url,
    payload: body as object | undefined,
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
  return { status: res.statusCode, body: res.json() as any };
}

/** A product as Wall2Roof's /api/v1/products returns it. */
function w2r(over: Record<string, unknown> = {}) {
  return {
    id: 1085,
    sku: '929003777101',
    mpn: '929003777101',
    gcode: null,
    hsn: '8539',
    name: 'Philips 9W LED Bulb B22 Cool Day Light',
    series: null,
    country: 'India',
    brand: { id: 4, name: 'Philips' },
    active: true,
    currency: 'INR',
    price: 799,
    special_price: 699,
    mrp: 799,
    weight_kg: 0.05,
    short_description: '9W · B22 · 6500K',
    description_html: '<p>Bright <b>cool day</b> light.</p><ul><li>15,000 hours</li></ul>',
    images: ['https://example.com/1.jpg', 'https://example.com/2.jpg'],
    attributes: [
      { code: 'wattage', name: 'Wattage', value: '9', unit: 'W' },
      { code: 'base', name: 'Base', value: 'B22', unit: null },
      { code: 'empty', name: 'Empty', value: '', unit: null },
    ],
    store: { enabled: true, call_for_price: false, in_stock: true, qty: 25, categories: [] },
    created_at: '2026-10-01 10:00:00',
    updated_at: '2026-10-14 06:27:19',
    ...over,
  };
}

beforeAll(async () => {
  h = await openDb({ memory: true });
  app = await buildApp(h.db, {}, { integrationKey: KEY });
  const [lighting] = await h.db.insert(categories).values({ slug: 'lighting', name: 'Lighting', sort: 0 }).returning();
  const [bulbs] = await h.db.insert(categories).values({ slug: 'led-bulbs', name: 'LED Bulbs', parentId: lighting.id, sort: 1 }).returning();
  lightingId = lighting.id;
  bulbsId = bulbs.id;
});

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('auth', () => {
  it('answers 503 while no key (or a short key) is configured', async () => {
    for (const integrationKey of [null, 'too-short']) {
      const bare = await buildApp(h.db, {}, { integrationKey });
      const r = await call('GET', '/v1/integration/categories', undefined, KEY, bare);
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ error: 'Integration API is not configured on this server.' });
      await bare.close();
    }
  });

  it('rejects a missing or wrong key with 401', async () => {
    expect((await call('GET', '/v1/integration/categories', undefined, null)).status).toBe(401);
    expect((await call('GET', '/v1/integration/categories', undefined, `${KEY}x`)).status).toBe(401);
  });

  it('never accepts the key in the query string', async () => {
    const r = await call('GET', `/v1/integration/categories?key=${KEY}&api_key=${KEY}`, undefined, null);
    expect(r.status).toBe(401);
  });

  it('does not let a customer token in', async () => {
    const r = await call('GET', '/v1/integration/categories', undefined, 'eyJhbGciOiJIUzI1NiJ9.e30.signature');
    expect(r.status).toBe(401);
  });
});

describe('mapping', () => {
  it('follows the contract field by field', () => {
    const m = mapWall2RoofProduct(w2r() as never);
    expect(m).toMatchObject({
      name: 'Philips 9W LED Bulb B22 Cool Day Light',
      brandName: 'Philips',
      subtitle: '9W · B22 · 6500K',
      pricePaise: 69900, // special price wins
      mrpPaise: 79900,
      isActive: true,
      images: ['https://example.com/1.jpg', 'https://example.com/2.jpg'],
      specs: [
        { label: 'Wattage', value: '9 W' },
        { label: 'Base', value: 'B22' },
      ],
    });
  });

  it('never lets MRP fall below the price, and keeps priceless products inactive', () => {
    expect(mapWall2RoofProduct(w2r({ special_price: null, mrp: 500, price: 650 }) as never)).toMatchObject({ pricePaise: 65000, mrpPaise: 65000 });
    expect(mapWall2RoofProduct(w2r({ price: null, special_price: null, mrp: null }) as never)).toMatchObject({ pricePaise: null, isActive: false });
    expect(mapWall2RoofProduct(w2r({ active: false }) as never).isActive).toBe(false);
  });
});

describe('products', () => {
  it('creates a product on first push, with brand and category', async () => {
    const r = await call('PUT', '/v1/integration/products/929003777101', { product: w2r(), category_id: bulbsId, stock_qty: 10 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, created: true });
    const [p] = await h.db.select().from(products).where(eq(products.sku, '929003777101'));
    expect(p).toMatchObject({ source: 'laravel', sourceId: '1085', categoryId: bulbsId, stockQty: 10, pricePaise: 69900, isActive: true });
    const [b] = await h.db.select().from(brands).where(eq(brands.id, p.brandId!));
    expect(b.name).toBe('Philips');
  });

  it('updates on a second push and keeps category/stock/slug when not sent', async () => {
    const before = (await h.db.select().from(products).where(eq(products.sku, '929003777101')))[0];
    await h.db.update(products).set({ ratingCount: 42, maxPerOrder: 5 }).where(eq(products.id, before.id));
    const r = await call('PUT', '/v1/integration/products/929003777101', { product: w2r({ name: 'Philips 9W LED Bulb (new)', special_price: null }) });
    expect(r.body).toMatchObject({ ok: true, id: before.id, created: false });
    const [p] = await h.db.select().from(products).where(eq(products.id, before.id));
    expect(p).toMatchObject({
      name: 'Philips 9W LED Bulb (new)',
      pricePaise: 79900,
      categoryId: bulbsId,
      stockQty: 10,
      slug: before.slug,
      ratingCount: 42,
      maxPerOrder: 5,
    });
  });

  it('shows the product in the store with its description as text', async () => {
    const [p] = await h.db.select().from(products).where(eq(products.sku, '929003777101'));
    const r = await app.inject({ method: 'GET', url: `/v1/products/${p.slug}` });
    expect(r.json().description).toBe('Bright cool day light.\n\n• 15,000 hours');
  });

  it('rejects bad input with 422', async () => {
    expect((await call('PUT', '/v1/integration/products/OTHER', { product: w2r() })).status).toBe(422); // sku mismatch
    expect((await call('PUT', '/v1/integration/products/929003777101', { product: w2r(), category_id: 99999 })).status).toBe(422);
    const bad = await call('PUT', '/v1/integration/products/929003777101', { product: { sku: '929003777101' } });
    expect(bad.status).toBe(422);
    expect(typeof bad.body.error).toBe('string');
  });

  it('lists products with filters, paging and category path', async () => {
    await call('PUT', '/v1/integration/products/W2R-2', { product: w2r({ id: 2, sku: 'W2R-2', name: 'Anchor Switch', brand: { id: 9, name: 'Anchor' }, active: false }) });
    const all = await call('GET', '/v1/integration/products?per_page=1');
    expect(all.body.meta).toEqual({ page: 1, per_page: 1, total: 2, last_page: 2 });
    const active = await call('GET', '/v1/integration/products?active=1');
    expect(active.body.data.map((p: any) => p.sku)).toEqual(['929003777101']);
    expect(active.body.data[0]).toMatchObject({
      source: 'laravel',
      source_id: '1085',
      brand: 'Philips',
      category: { id: bulbsId, name: 'LED Bulbs', path: 'Lighting › LED Bulbs' },
      price_paise: 79900,
      stock_qty: 10,
      is_active: true,
    });
    expect((await call('GET', '/v1/integration/products?q=anchor')).body.data).toHaveLength(1);
    expect((await call('GET', `/v1/integration/products?category_id=${lightingId}`)).body.data).toHaveLength(0);
    expect((await call('GET', '/v1/integration/products?per_page=500')).status).toBe(422);
  });

  it('returns all SKUs', async () => {
    expect((await call('GET', '/v1/integration/products/skus')).body).toEqual({ skus: ['929003777101', 'W2R-2'] });
  });
});

describe('categories', () => {
  it('lists every category, active or not', async () => {
    await h.db.insert(categories).values({ slug: 'old', name: 'Old', isActive: false, sort: 9 });
    const r = await call('GET', '/v1/integration/categories');
    expect(r.body.data).toEqual([
      { id: lightingId, name: 'Lighting', slug: 'lighting', parent_id: null, is_active: true, sort: 0 },
      { id: bulbsId, name: 'LED Bulbs', slug: 'led-bulbs', parent_id: lightingId, is_active: true, sort: 1 },
      expect.objectContaining({ slug: 'old', is_active: false }),
    ]);
  });
});

describe('orders', () => {
  let number: string;

  beforeAll(async () => {
    // A customer places a COD order through the app API.
    const otp = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '9811122233' } });
    const login = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: '9811122233', code: otp.json().devCode } });
    const token = login.json().accessToken;
    const auth = { authorization: `Bearer ${token}` };
    const addr = await app.inject({
      method: 'POST',
      url: '/v1/addresses',
      headers: auth,
      payload: { name: 'Ravi', phone: '9811122233', line1: 'Shop 4, Main Bazaar', city: 'Muktsar', state: 'Punjab', pincode: '152026' },
    });
    const [p] = await h.db.select().from(products).where(eq(products.sku, '929003777101'));
    await app.inject({ method: 'PUT', url: '/v1/cart/items', headers: auth, payload: { productId: p.id, qty: 2 } });
    const order = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: auth,
      payload: { addressId: addr.json().address.id, paymentMethod: 'cod', idempotencyKey: 'integration-order-1' },
    });
    expect(order.statusCode).toBe(201);
    number = order.json().number;
  });

  it('lists orders newest first with customer and item count', async () => {
    const r = await call('GET', '/v1/integration/orders');
    expect(r.body.meta.total).toBe(1);
    expect(r.body.data[0]).toMatchObject({
      number,
      status: 'placed',
      payment_method: 'cod',
      payment_status: 'cod_due',
      item_count: 2,
      customer: { phone: '9811122233' },
    });
    expect((await call('GET', '/v1/integration/orders?q=22233')).body.data).toHaveLength(1);
    expect((await call('GET', `/v1/integration/orders?q=${number}`)).body.data).toHaveLength(1);
    expect((await call('GET', '/v1/integration/orders?status=delivered')).body.data).toHaveLength(0);
    expect((await call('GET', '/v1/integration/orders?from=2000-01-01&to=2000-01-02')).body.data).toHaveLength(0);
    expect((await call('GET', '/v1/integration/orders?from=13-10-2026')).status).toBe(422);
  });

  it('returns the full order with next statuses', async () => {
    const r = await call('GET', `/v1/integration/orders/${number}`);
    expect(r.body).toMatchObject({
      number,
      customer: { phone: '9811122233' },
      address: { city: 'Muktsar', pincode: '152026' },
      items: [{ sku: '929003777101', qty: 2, unit_price_paise: 79900 }],
      subtotal_paise: 159800,
      events: [{ status: 'placed' }],
      next_statuses: ['confirmed', 'cancelled'],
    });
    expect((await call('GET', '/v1/integration/orders/ED-0000-00000')).status).toBe(404);
  });

  it('moves the order along with the same rules as the admin route', async () => {
    expect((await call('POST', `/v1/integration/orders/${number}/status`, { status: 'delivered' })).status).toBe(409);
    for (const status of ['confirmed', 'packed', 'out_for_delivery', 'delivered']) {
      expect((await call('POST', `/v1/integration/orders/${number}/status`, { status, note: 'via Wall2Roof' })).body).toEqual({ ok: true });
    }
    const r = await call('GET', `/v1/integration/orders/${number}`);
    expect(r.body).toMatchObject({ status: 'delivered', payment_status: 'paid', next_statuses: [] });
    expect(r.body.events.map((e: any) => e.status)).toEqual(['placed', 'confirmed', 'packed', 'out_for_delivery', 'delivered']);
    const bad = await call('POST', `/v1/integration/orders/${number}/status`, { status: 'cancelled' });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toMatch(/delivered to cancelled/);
  });

  it('restocks when the store cancels', async () => {
    const [p] = await h.db.select().from(products).where(eq(products.sku, '929003777101'));
    const stockBefore = p.stockQty;
    // A second order to cancel.
    const otp = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '9811100000' } });
    const login = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: '9811100000', code: otp.json().devCode } });
    const auth = { authorization: `Bearer ${login.json().accessToken}` };
    const addr = await app.inject({
      method: 'POST',
      url: '/v1/addresses',
      headers: auth,
      payload: { name: 'Asha', phone: '9811100000', line1: 'House 12, Model Town', city: 'Muktsar', state: 'Punjab', pincode: '152026' },
    });
    await app.inject({ method: 'PUT', url: '/v1/cart/items', headers: auth, payload: { productId: p.id, qty: 3 } });
    const order = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: auth,
      payload: { addressId: addr.json().address.id, paymentMethod: 'cod', idempotencyKey: 'integration-order-2' },
    });
    const n2 = order.json().number;
    expect((await call('POST', `/v1/integration/orders/${n2}/status`, { status: 'cancelled', note: 'Out of area' })).body).toEqual({ ok: true });
    const [after] = await h.db.select().from(products).where(eq(products.id, p.id));
    expect(after.stockQty).toBe(stockBefore);
    expect((await call('GET', `/v1/integration/orders/${n2}`)).body).toMatchObject({ status: 'cancelled', cancel_reason: 'Out of area' });
  });
});
