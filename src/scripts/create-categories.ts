/**
 * Create (or update) the store's main categories. Safe to run again: matches
 * on slug, so names/order/colours are updated and nothing is duplicated.
 *
 *   npm run categories:create
 */
import { sql } from 'drizzle-orm';

import { openDb } from '../db/client.js';
import { categories } from '../db/schema.js';

/** Order = order in the app. Tint = pastel tile colour from the mockup palette. */
export const STORE_CATEGORIES = [
  { slug: 'wires-cables', name: 'Wires & Cables', tint: '#FDECEC' },
  { slug: 'switches-sockets', name: 'Switches & Sockets', tint: '#F3F4F6' },
  { slug: 'ceiling-lights', name: 'Ceiling Lights', tint: '#EEF5FD' },
  { slug: 'hanging-lights', name: 'Hanging Lights', tint: '#FFF6E5' },
  { slug: 'led-light-bulbs', name: 'LED Light Bulbs', tint: '#FFF8E1' },
  { slug: 'smart-lights', name: 'Smart Lights', tint: '#EEF0FD' },
];

const { db, close } = await openDb();
for (const [i, c] of STORE_CATEGORIES.entries()) {
  await db
    .insert(categories)
    .values({ ...c, sort: i, parentId: null, isActive: true, source: 'admin' })
    .onConflictDoUpdate({
      target: categories.slug,
      set: { name: c.name, tint: c.tint, sort: i, parentId: null, isActive: true, updatedAt: new Date() },
    });
}
const rows = await db.execute<{ id: number; name: string; slug: string; sort: number }>(
  sql`select id, name, slug, sort from categories order by sort, name`,
);
const list = (rows as unknown as { rows?: { id: number; name: string; slug: string }[] }).rows ?? [];
console.log(`${list.length} categories in the database:`);
for (const r of list) console.log(`  #${r.id}  ${r.name.padEnd(20)} ${r.slug}`);
await close();
