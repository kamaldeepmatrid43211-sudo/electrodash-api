import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

/**
 * The server's own copies of images (products, categories, banners), kept on disk — the
 * Railway volume in production — so the app no longer depends on other websites keeping them.
 * A file is named after its content, so the same picture is only ever stored once and its
 * address never changes (phones may cache it for a year).
 */

/** A stored image's name: 32 hex characters of its SHA-256 plus its type. */
export const NAME_RE = /^[a-f0-9]{32}\.(jpg|png|webp|gif|avif)$/;
export const CONTENT_TYPE: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
/** Widths the server makes; a request snaps up to the next one, so only a few sizes are ever stored. */
export const WIDTHS = [160, 320, 480, 640, 960, 1280] as const;
const MAX_BYTES = 15 * 1024 * 1024;
/** sharp's format name → our file type. No SVG: it can carry scripts. */
const FORMATS: Record<string, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif', heif: 'avif' };

export class ImageError extends Error {}

const exists = (file: string) => access(file).then(() => true, () => false);

/** Write next to the target and rename, so a half-written file is never served. */
async function writeAtomic(file: string, write: (tmp: string) => Promise<unknown>) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await write(tmp);
  await rename(tmp, file);
}

export class ImageStore {
  constructor(readonly dir: string) {}

  path(name: string) {
    return join(this.dir, name);
  }

  has(name: string) {
    return exists(this.path(name));
  }

  /** Save image bytes and return the file name. The real type is read from the bytes, not trusted from the sender. */
  async save(bytes: Buffer): Promise<string> {
    let format: string | undefined;
    try {
      format = (await sharp(bytes).metadata()).format;
    } catch {
      throw new ImageError('not an image');
    }
    const ext = format ? FORMATS[format] : undefined;
    if (!ext) throw new ImageError(`unsupported image type (${format ?? 'unknown'})`);
    const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${ext}`;
    const file = this.path(name);
    if (!(await exists(file))) await writeAtomic(file, (tmp) => writeFile(tmp, bytes));
    return name;
  }

  /** The image at (at most) this width as WebP, made on first request and kept. null = no such image. */
  async sized(name: string, width: number): Promise<string | null> {
    if (!(await this.has(name))) return null;
    const out = join(this.dir, 'w', `${name.slice(0, 32)}-${width}.webp`);
    if (!(await exists(out))) {
      await writeAtomic(out, (tmp) =>
        sharp(this.path(name)).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 80 }).toFile(tmp),
      );
    }
    return out;
  }
}

/** Addresses inside private networks: this machine, the office network, Railway's internal network. */
function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  if (v.includes(':')) return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  const [a, b] = v.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function assertPublic(url: URL) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ImageError('only http(s) links can be copied');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.internal') || host.endsWith('.local')) throw new ImageError('private address');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.some(isPrivateIp)) throw new ImageError('private address');
}

/**
 * Download an image from another website. Links into private networks are refused (the
 * database and Railway's internal services must never be fetched), and so is anything too big.
 * `allowPrivate` is for tests only.
 */
export async function downloadImage(link: string, { allowPrivate = false } = {}): Promise<Buffer> {
  let url = new URL(link);
  for (let hop = 0; ; hop++) {
    if (!allowPrivate) await assertPublic(url);
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'ElectroDash image copier' } });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop >= 3) throw new ImageError('too many redirects');
      url = new URL(location, url); // each hop is checked again
      continue;
    }
    if (!res.ok) throw new ImageError(`the website answered ${res.status}`);
    if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) throw new ImageError('image is bigger than 15 MB');
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw new ImageError('image is bigger than 15 MB');
    return bytes;
  }
}
