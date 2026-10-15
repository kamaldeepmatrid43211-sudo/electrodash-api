/**
 * DEMO DATA for local development only — the products, coupons and settings
 * shown in the ElectroDash mockup. Every row is marked source = 'demo'.
 * Real products come from the Laravel catalogue sync. Refuses to run in production.
 *
 *   npm run seed:demo
 */
import { randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { config } from '../config.js';
import { openDb, type Db } from '../db/client.js';
import { brands, categories, coupons, products, users } from '../db/schema.js';
import { hashPassword } from '../lib/auth.js';
import { setSetting } from '../lib/settings.js';

if (config.isProd) {
  console.error('Demo seed is for local development only.');
  process.exit(1);
}

const CATS: { slug: string; name: string; tint: string; parent?: string }[] = [
  { slug: 'led-tubes', name: 'LED & Tubes', tint: '#EEF5FD' },
  { slug: 'led-bulbs', name: 'LED Bulbs', tint: '#EEF5FD', parent: 'led-tubes' },
  { slug: 'battens-tubes', name: 'Battens & Tubes', tint: '#EEF5FD', parent: 'led-tubes' },
  { slug: 'emergency-lights', name: 'Emergency Lights', tint: '#EEF5FD', parent: 'led-tubes' },
  { slug: 'wires-cables', name: 'Wires & Cables', tint: '#FDECEC' },
  { slug: 'switches-sockets', name: 'Switches', tint: '#F3F4F6' },
  { slug: 'extension-boards', name: 'Extension Boards', tint: '#EEF5FD' },
  { slug: 'mcbs-fuses', name: 'MCBs & Fuses', tint: '#EEF5FD' },
  { slug: 'fans', name: 'Fans', tint: '#ECF7F2' },
  { slug: 'tools', name: 'Tools', tint: '#FDF1EC' },
  { slug: 'chargers-adapters', name: 'Plugs & Adapters', tint: '#F3F4F6' },
];

type P = {
  sku: string;
  name: string;
  brand: string;
  cat: string;
  subtitle: string;
  price: number;
  mrp: number;
  stock: number;
  rating?: [number, number];
  best?: boolean;
  group?: [string, string];
  specs?: [string, string][];
  returnable?: boolean;
};

const PRODUCTS: P[] = [
  { sku: 'DEMO-PH-9W-CD-1', name: '9W LED Bulb, Cool Day Light (B22)', brand: 'Philips', cat: 'led-bulbs', subtitle: '9W · B22 · 6500K', price: 99, mrp: 150, stock: 120, rating: [46, 1284], best: true, group: ['ph-9w-cd', 'Pack of 1'], specs: [['Wattage', '9 W'], ['Base', 'B22'], ['Colour temperature', '6500 K (cool day light)'], ['Lumens', '900 lm'], ['Life', '15,000 hours']] },
  { sku: 'DEMO-PH-9W-CD-2', name: '9W LED Bulb, Cool Day Light (B22), Pack of 2', brand: 'Philips', cat: 'led-bulbs', subtitle: '9W · B22 · 6500K', price: 189, mrp: 300, stock: 60, rating: [46, 1284], group: ['ph-9w-cd', 'Pack of 2'] },
  { sku: 'DEMO-PH-9W-CD-4', name: '9W LED Bulb, Pack of 4', brand: 'Philips', cat: 'led-bulbs', subtitle: '9W · B22 · 6500K', price: 349, mrp: 600, stock: 40, rating: [46, 418], group: ['ph-9w-cd', 'Pack of 4'] },
  { sku: 'DEMO-WP-9W-WW', name: '9W LED Bulb, Warm White', brand: 'Wipro', cat: 'led-bulbs', subtitle: '9W · B22 · 2700K', price: 95, mrp: 140, stock: 80, rating: [44, 962], best: true },
  { sku: 'DEMO-WP-9W-INV', name: '9W Rechargeable Inverter Bulb', brand: 'Wipro', cat: 'emergency-lights', subtitle: '9W · B22 · 4 hr backup', price: 349, mrp: 699, stock: 0, rating: [42, 233] },
  { sku: 'DEMO-SY-20W-BAT', name: '20W LED Batten Tube Light, 4 ft', brand: 'Syska', cat: 'battens-tubes', subtitle: '20W · 4 ft · 6500K', price: 249, mrp: 399, stock: 45, rating: [45, 671], best: true },
  { sku: 'DEMO-HV-EMG-LED', name: 'Rechargeable Emergency LED Light', brand: 'Havells', cat: 'emergency-lights', subtitle: '40 LEDs · 6 hr backup', price: 599, mrp: 999, stock: 18, rating: [43, 310] },
  { sku: 'DEMO-AN-EXT-4S', name: '4-Socket Extension Board, Surge Protection', brand: 'Anchor', cat: 'extension-boards', subtitle: '2 m cord · 6A', price: 499, mrp: 799, stock: 30, rating: [44, 845], best: true },
  { sku: 'DEMO-AN-SKT-16A', name: '16A 3-Pin Power Socket', brand: 'Anchor', cat: 'switches-sockets', subtitle: 'Modular · White', price: 149, mrp: 210, stock: 70, rating: [45, 402] },
  { sku: 'DEMO-AN-SW-6A', name: '6A 1-Way Modular Switch', brand: 'Anchor', cat: 'switches-sockets', subtitle: '1 module · White', price: 89, mrp: 120, stock: 150, rating: [46, 1190], best: true },
  { sku: 'DEMO-HV-MCB-32C', name: '32A Single-Pole MCB, C-Curve', brand: 'Havells', cat: 'mcbs-fuses', subtitle: '32A · SP · C-curve', price: 249, mrp: 380, stock: 2, rating: [47, 288] },
  { sku: 'DEMO-FX-WIRE-15', name: '1.5 sq mm FR PVC Copper Wire, 10 m', brand: 'Finolex', cat: 'wires-cables', subtitle: '1.5 sq mm · 10 m · Red', price: 399, mrp: 599, stock: 55, rating: [46, 540], best: true, returnable: false, specs: [['Size', '1.5 sq mm'], ['Length', '10 m'], ['Insulation', 'FR PVC'], ['Conductor', 'Copper']] },
  { sku: 'DEMO-TP-VTEST', name: 'Digital Voltage Tester', brand: 'Taparia', cat: 'tools', subtitle: '12–250V AC', price: 199, mrp: 299, stock: 25, rating: [42, 156] },
  { sku: 'DEMO-PT-USB-20W', name: '20W Dual-Port USB Power Adapter', brand: 'Portronics', cat: 'chargers-adapters', subtitle: 'USB-A + USB-C · 20W', price: 299, mrp: 499, stock: 35, rating: [43, 210] },
  { sku: 'DEMO-CR-FAN-1200', name: '1200 mm Ceiling Fan, High Speed', brand: 'Crompton', cat: 'fans', subtitle: '1200 mm · 390 RPM', price: 1699, mrp: 2450, stock: 12, rating: [44, 980] },
];

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

async function seed(db: Db) {
  const catId = new Map<string, number>();
  for (const [i, c] of CATS.entries()) {
    const [row] = await db
      .insert(categories)
      .values({ slug: c.slug, name: c.name, tint: c.tint, sort: i, parentId: c.parent ? catId.get(c.parent) : null, source: 'demo' })
      .onConflictDoUpdate({ target: categories.slug, set: { name: c.name, tint: c.tint } })
      .returning();
    catId.set(c.slug, row.id);
  }
  const brandId = new Map<string, number>();
  for (const name of new Set(PRODUCTS.map((p) => p.brand))) {
    const [row] = await db
      .insert(brands)
      .values({ slug: slugify(name), name, source: 'demo' })
      .onConflictDoUpdate({ target: brands.slug, set: { name } })
      .returning();
    brandId.set(name, row.id);
  }
  for (const p of PRODUCTS) {
    const values = {
      sku: p.sku,
      slug: slugify(`${p.brand} ${p.name}`),
      name: p.name,
      subtitle: p.subtitle,
      brandId: brandId.get(p.brand),
      categoryId: catId.get(p.cat),
      pricePaise: p.price * 100,
      mrpPaise: p.mrp * 100,
      stockQty: p.stock,
      ratingAvg: p.rating?.[0] ?? null,
      ratingCount: p.rating?.[1] ?? 0,
      isBestseller: !!p.best,
      variantGroup: p.group?.[0] ?? null,
      variantLabel: p.group?.[1] ?? null,
      specs: (p.specs ?? []).map(([label, value]) => ({ label, value })),
      returnable: p.returnable ?? true,
      description: 'Demo product for local development.',
      source: 'demo' as const,
    };
    await db.insert(products).values(values).onConflictDoUpdate({ target: products.sku, set: values });
  }

  const COUPONS = [
    { code: 'DASH20', title: '20% off your first order', type: 'percent' as const, value: 20, maxDiscountPaise: 10000, minOrderPaise: 29900, firstOrderOnly: true },
    { code: 'FREEDEL', title: 'Free delivery, no minimum', type: 'free_delivery' as const, value: 0, maxDiscountPaise: 2500, minOrderPaise: 0, firstOrderOnly: false },
    { code: 'BULB15', title: '15% off on lighting', type: 'percent' as const, value: 15, maxDiscountPaise: 7500, minOrderPaise: 29900, firstOrderOnly: false, categoryId: catId.get('led-tubes') },
  ];
  for (const c of COUPONS) {
    await db
      .insert(coupons)
      .values({ ...c, validUntil: new Date('2026-12-31T23:59:59+05:30') })
      .onConflictDoUpdate({ target: coupons.code, set: c });
  }
  // BULB15 targets the parent "LED & Tubes"; products sit in its children, so
  // point it at led-bulbs for the demo (category coupons match one category).
  await db.update(coupons).set({ categoryId: catId.get('led-bulbs') }).where(eq(coupons.code, 'BULB15'));

  await setSetting(db, 'deliveryEtaText', '12 minutes');
  await setSetting(db, 'storeAreaText', 'HSR Layout, Bengaluru');
  await setSetting(db, 'supportPhone', '1800-000-0000');
  await setSetting(db, 'supportEmail', 'support@electrodash.in');
  await setSetting(db, 'supportHoursText', '7 AM – 12 AM');

  const adminEmail = 'admin@electrodash.local';
  const [existing] = await db.select().from(users).where(eq(users.email, adminEmail));
  if (!existing) {
    const password = process.env.DEMO_ADMIN_PASSWORD ?? randomBytes(9).toString('base64url');
    await db.insert(users).values({ name: 'Demo Admin', email: adminEmail, passwordHash: await hashPassword(password), role: 'admin' });
    console.log(`Demo admin: ${adminEmail} / ${password}  (local only)`);
  }
  console.log(`Seeded ${CATS.length} categories, ${PRODUCTS.length} products, ${COUPONS.length} coupons (demo).`);
}

const { db, close } = await openDb();
await seed(db);
await close();
