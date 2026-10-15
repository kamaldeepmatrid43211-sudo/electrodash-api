/**
 * Connect to the configured database, apply migrations (creates all tables on
 * first run) and list the tables with row counts.
 *
 *   npm run db:check
 */
import { sql } from 'drizzle-orm';

import { config } from '../config.js';
import { openDb } from '../db/client.js';

function where(): string {
  if (!config.DATABASE_URL) return `local test database (${config.PGLITE_DIR})`;
  const u = new URL(config.DATABASE_URL);
  return `${u.hostname}:${u.port || 5432}${u.pathname} (PostgreSQL)`; // never print the password
}

console.log(`Connecting to ${where()} …`);
const started = Date.now();
const { db, close } = await openDb();
const res = await db.execute<{ table_name: string }>(
  sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
);
const tables = (res as unknown as { rows?: { table_name: string }[] }).rows ?? (res as unknown as { table_name: string }[]);
console.log(`Connected and up to date in ${Date.now() - started} ms. ${tables.length} tables:`);
for (const { table_name } of tables) {
  const c = await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from "${table_name}"`));
  const rows = (c as unknown as { rows?: { n: number }[] }).rows ?? (c as unknown as { n: number }[]);
  console.log(`  ${table_name.padEnd(20)} ${rows[0]?.n ?? 0} rows`);
}
await close();
