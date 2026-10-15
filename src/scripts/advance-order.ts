/**
 * LOCAL DEVELOPMENT ONLY — move an order to its next status, standing in for
 * the store/admin panel until it exists.
 *
 *   npm run dev:advance -- ED-2026-10001            (next step)
 *   npm run dev:advance -- ED-2026-10001 delivered  (specific status)
 */
import { config } from '../config.js';
import { signAccessToken } from '../lib/auth.js';

if (config.isProd) {
  console.error('dev:advance is for local development only.');
  process.exit(1);
}

const [number, target] = process.argv.slice(2);
if (!number) {
  console.error('Usage: npm run dev:advance -- <order number> [status]');
  process.exit(1);
}

const base = `http://localhost:${config.PORT}`;
const token = await signAccessToken(0, 'admin');
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

let status = target;
if (!status) {
  // Admin can't read customer orders through the customer API, so walk the chain until one move succeeds.
  for (const s of ['confirmed', 'packed', 'out_for_delivery', 'delivered']) {
    const r = await fetch(`${base}/v1/admin/orders/${number}/status`, { method: 'POST', headers: auth, body: JSON.stringify({ status: s }) });
    if (r.ok) {
      console.log(`${number} → ${s}`);
      process.exit(0);
    }
  }
  console.error(`${number}: nothing to advance (already delivered/cancelled, or not found).`);
  process.exit(1);
}
const r = await fetch(`${base}/v1/admin/orders/${number}/status`, { method: 'POST', headers: auth, body: JSON.stringify({ status }) });
console.log(r.ok ? `${number} → ${status}` : `Failed: ${(await r.json()).error?.message}`);
