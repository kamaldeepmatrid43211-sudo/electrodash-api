import { and, asc, desc, eq, gte, ilike, inArray, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/client.js';
import { banners, brands, categories, homeSections, products, type Spec } from '../db/schema.js';
import { HttpError, parse } from '../http.js';
import { htmlToText } from '../lib/html.js';
import { getSettings, isServiceable } from '../lib/settings.js';

const TAG_SKIP = /country|origin|warranty|dimension|size|brand|model|sku|hsn|weight|capacity|time|angle|lumen/i;
const TAG_PREFER = [/watt/i, /light colou?r|colou?r temp/i, /colou?r/i, /shape/i, /material/i, /bulb|base|head|type/i];

/**
 * Up to two short spec values for a card's tag chips (Blinkit's "Dry skin" / "IPX5"), e.g.
 * "10W" and "Warm White": short values only, the most useful labels first.
 */
export function cardTags(specs: Spec[]): string[] {
  const rank = (s: Spec) => {
    const i = TAG_PREFER.findIndex((re) => re.test(s.label));
    return i === -1 ? TAG_PREFER.length : i;
  };
  const values = specs
    .filter((s) => s.value && s.value.length <= 14 && !/[()]/.test(s.value) && !TAG_SKIP.test(s.label))
    .sort((a, b) => rank(a) - rank(b))
    .map((s) => s.value.trim());
  return [...new Set(values)].slice(0, 2);
}

/** Public product shape (cards, lists). */
export function productCard(p: typeof products.$inferSelect, brand?: { name: string } | null) {
  const discountPct = p.mrpPaise > p.pricePaise ? Math.round(((p.mrpPaise - p.pricePaise) / p.mrpPaise) * 100) : 0;
  return {
    id: p.id,
    sku: p.sku,
    slug: p.slug,
    name: p.name,
    subtitle: p.subtitle,
    brand: brand?.name ?? null,
    image: p.images[0] ?? null,
    /** First few photos, for swiping through them on the card. */
    images: p.images.slice(0, 5),
    tags: cardTags(p.specs),
    pricePaise: p.pricePaise,
    mrpPaise: p.mrpPaise,
    discountPct,
    rating: p.ratingAvg != null ? p.ratingAvg / 10 : null,
    ratingCount: p.ratingCount,
    inStock: p.isActive && p.stockQty > 0,
    stockLeft: p.stockQty > 0 && p.stockQty <= 3 ? p.stockQty : null,
    maxPerOrder: Math.max(0, Math.min(p.maxPerOrder, p.stockQty)),
    variantLabel: p.variantLabel,
  };
}

/**
 * Home banners for the app. A banner whose category or product is gone or hidden still shows,
 * but tapping it does nothing, so a stale link never opens a "not available" page.
 */
async function bannerCards(db: Db, rows: (typeof banners.$inferSelect)[]) {
  const slugsOf = (type: 'category' | 'product') =>
    [...new Set(rows.filter((b) => b.linkType === type && b.linkTarget).map((b) => b.linkTarget!))];
  const catSlugs = slugsOf('category');
  const productSlugs = slugsOf('product');
  const [liveCats, liveProducts] = await Promise.all([
    catSlugs.length
      ? db.select({ slug: categories.slug }).from(categories).where(and(inArray(categories.slug, catSlugs), eq(categories.isActive, true)))
      : [],
    productSlugs.length
      ? db.select({ slug: products.slug }).from(products).where(and(inArray(products.slug, productSlugs), eq(products.isActive, true)))
      : [],
  ]);
  const live = { category: new Set(liveCats.map((c) => c.slug)), product: new Set(liveProducts.map((p) => p.slug)) };

  return rows.map((b) => {
    const ok =
      b.linkType === 'offers' || ((b.linkType === 'category' || b.linkType === 'product') && live[b.linkType].has(b.linkTarget ?? ''));
    return {
      id: b.id,
      title: b.title,
      imageUrl: b.imageUrl,
      link: ok ? { type: b.linkType, target: b.linkType === 'offers' ? null : b.linkTarget } : null,
    };
  });
}

/**
 * Live home sections with their categories in the admin's order. A category is left out while
 * it's hidden or has no product shown in the app (counting its subcategories), and a section
 * with no category left is skipped.
 */
async function homeSectionCards(db: Db) {
  const rows = await db
    .select()
    .from(homeSections)
    .where(eq(homeSections.isActive, true))
    .orderBy(asc(homeSections.sort), asc(homeSections.id));
  if (!rows.length) return [];

  const [cats, counts] = await Promise.all([
    db
      .select({ id: categories.id, parentId: categories.parentId, slug: categories.slug, name: categories.name, imageUrl: categories.imageUrl, tint: categories.tint, isActive: categories.isActive })
      .from(categories),
    db
      .select({ categoryId: products.categoryId, n: sql<number>`count(*)::int` })
      .from(products)
      .where(eq(products.isActive, true))
      .groupBy(products.categoryId),
  ]);
  const direct = new Map(counts.map((c) => [c.categoryId, c.n]));
  const kids = new Map<number, number[]>();
  for (const c of cats) if (c.parentId != null) kids.set(c.parentId, [...(kids.get(c.parentId) ?? []), c.id]);
  const total = (id: number, depth = 0): number =>
    (direct.get(id) ?? 0) + (depth < 10 ? (kids.get(id) ?? []).reduce((sum, k) => sum + total(k, depth + 1), 0) : 0);
  const byId = new Map(cats.map((c) => [c.id, c]));

  return rows
    .map((s) => ({
      id: s.id,
      title: s.title,
      subtitle: s.subtitle,
      categories: s.categoryIds
        .map((id) => byId.get(id))
        .filter((c): c is NonNullable<typeof c> => !!c && c.isActive && total(c.id) > 0)
        .map((c) => ({ slug: c.slug, name: c.name, imageUrl: c.imageUrl, tint: c.tint })),
    }))
    .filter((s) => s.categories.length > 0);
}

const listQuery = z.object({
  category: z.string().optional(),
  brand: z.union([z.string(), z.array(z.string())]).optional(),
  q: z.string().trim().max(100).optional(),
  minPrice: z.coerce.number().int().nonnegative().optional(),
  maxPrice: z.coerce.number().int().nonnegative().optional(),
  inStock: z.enum(['1', 'true']).optional(),
  sort: z.enum(['relevance', 'price_asc', 'price_desc', 'discount', 'rating', 'newest']).default('relevance'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** All category ids under (and including) the given slug. */
async function categoryIdsFor(db: Db, slug: string): Promise<number[]> {
  const all = await db.select({ id: categories.id, parentId: categories.parentId, slug: categories.slug }).from(categories);
  const root = all.find((c) => c.slug === slug);
  if (!root) return [];
  const ids = [root.id];
  for (let i = 0; i < ids.length; i++) for (const c of all) if (c.parentId === ids[i]) ids.push(c.id);
  return ids;
}

function searchCondition(q: string): SQL {
  const words = q.split(/\s+/).filter(Boolean).slice(0, 6);
  // Every word must match name, subtitle, SKU or brand (prefix-friendly ILIKE).
  return and(
    ...words.map((w) => {
      const like = `%${w.replace(/[%_]/g, '')}%`;
      return or(
        ilike(products.name, like),
        ilike(products.subtitle, like),
        ilike(products.sku, like),
        ilike(brands.name, like),
      )!;
    }),
  )!;
}

export async function catalogRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.get('/v1/config', async () => {
    const s = await getSettings(db);
    return {
      deliveryEtaText: s.deliveryEtaText,
      storeAreaText: s.storeAreaText,
      deliveryFeePaise: s.deliveryFeePaise,
      freeDeliveryMinPaise: s.freeDeliveryMinPaise,
      handlingFeePaise: s.handlingFeePaise,
      codFeePaise: s.codFeePaise,
      codEnabled: s.codEnabled,
      onlinePaymentsEnabled: s.onlinePaymentsEnabled,
      support: { phone: s.supportPhone, email: s.supportEmail, hours: s.supportHoursText },
    };
  });

  app.get('/v1/serviceability', async (req) => {
    const { pincode } = parse(z.object({ pincode: z.string().regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit PIN code') }), req.query);
    const s = await getSettings(db);
    const ok = isServiceable(s, pincode);
    return { pincode, serviceable: ok, deliveryEtaText: ok ? s.deliveryEtaText : '' };
  });

  app.get('/v1/categories', async () => {
    const rows = await db
      .select({
        id: categories.id,
        slug: categories.slug,
        name: categories.name,
        parentId: categories.parentId,
        imageUrl: categories.imageUrl,
        tint: categories.tint,
        sort: categories.sort,
        // Fully qualified: an unqualified ${categories.id} renders as "id" and would bind to p.id.
        productCount: sql<number>`(select count(*)::int from products p where p.category_id = categories.id and p.is_active)`,
      })
      .from(categories)
      .where(eq(categories.isActive, true))
      .orderBy(asc(categories.sort), asc(categories.name));
    type Node = (typeof rows)[number] & { children: Node[]; totalCount: number };
    const nodes = new Map<number, Node>(rows.map((r) => [r.id, { ...r, children: [], totalCount: r.productCount }]));
    const roots: Node[] = [];
    for (const n of nodes.values()) {
      const parent = n.parentId ? nodes.get(n.parentId) : undefined;
      if (parent) parent.children.push(n);
      else roots.push(n);
    }
    const total = (n: Node): number => (n.totalCount = n.productCount + n.children.reduce((s, c) => s + total(c), 0));
    roots.forEach(total);
    // Only categories with at least one active product (in them or a sub-category)
    // are shown, so customers never open an empty category.
    const withProducts = (list: Node[]): Node[] =>
      list.filter((n) => n.totalCount > 0).map((n) => ({ ...n, children: withProducts(n.children) }));
    return { categories: withProducts(roots) };
  });

  app.get('/v1/products', async (req) => {
    const q = parse(listQuery, req.query);
    const conds: SQL[] = [eq(products.isActive, true)];
    if (q.category) {
      const ids = await categoryIdsFor(db, q.category);
      if (!ids.length) return { items: [], total: 0, page: q.page, pages: 0, facets: { brands: [] } };
      conds.push(inArray(products.categoryId, ids));
    }
    if (q.q) conds.push(searchCondition(q.q));
    if (q.minPrice != null) conds.push(gte(products.pricePaise, q.minPrice));
    if (q.maxPrice != null) conds.push(lte(products.pricePaise, q.maxPrice));
    if (q.inStock) conds.push(sql`${products.stockQty} > 0`);
    const facetConds = [...conds];
    const brandSlugs = q.brand ? (Array.isArray(q.brand) ? q.brand : q.brand.split(',')) : [];
    if (brandSlugs.length) conds.push(inArray(brands.slug, brandSlugs));

    const where = and(...conds);
    const order =
      q.sort === 'price_asc'
        ? [asc(products.pricePaise)]
        : q.sort === 'price_desc'
          ? [desc(products.pricePaise)]
          : q.sort === 'discount'
            ? [desc(sql`(${products.mrpPaise} - ${products.pricePaise}) * 100 / greatest(${products.mrpPaise}, 1)`)]
            : q.sort === 'rating'
              ? [desc(sql`coalesce(${products.ratingAvg}, 0)`), desc(products.ratingCount)]
              : q.sort === 'newest'
                ? [desc(products.createdAt)]
                : [desc(sql`${products.stockQty} > 0`), desc(products.isBestseller), desc(products.ratingCount)];

    const [rows, [{ count }], brandFacets] = await Promise.all([
      db
        .select({ p: products, brandName: brands.name })
        .from(products)
        .leftJoin(brands, eq(brands.id, products.brandId))
        .where(where)
        .orderBy(...order, asc(products.id))
        .limit(q.limit)
        .offset((q.page - 1) * q.limit),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(products)
        .leftJoin(brands, eq(brands.id, products.brandId))
        .where(where),
      db
        .select({ slug: brands.slug, name: brands.name, count: sql<number>`count(*)::int` })
        .from(products)
        .innerJoin(brands, eq(brands.id, products.brandId))
        .where(and(...facetConds))
        .groupBy(brands.slug, brands.name)
        .orderBy(desc(sql`count(*)`)),
    ]);

    return {
      items: rows.map((r) => productCard(r.p, r.brandName ? { name: r.brandName } : null)),
      total: count,
      page: q.page,
      pages: Math.ceil(count / q.limit),
      facets: { brands: brandFacets },
    };
  });

  app.get('/v1/search/suggest', async (req) => {
    const { q } = parse(z.object({ q: z.string().trim().min(1).max(100) }), req.query);
    const [items, cats] = await Promise.all([
      db
        .select({ p: products, brandName: brands.name })
        .from(products)
        .leftJoin(brands, eq(brands.id, products.brandId))
        .where(and(eq(products.isActive, true), searchCondition(q)))
        .orderBy(desc(products.isBestseller), desc(products.ratingCount))
        .limit(6),
      db
        .select({ slug: categories.slug, name: categories.name })
        .from(categories)
        .where(and(eq(categories.isActive, true), ilike(categories.name, `%${q.replace(/[%_]/g, '')}%`)))
        .limit(3),
    ]);
    return {
      products: items.map((r) => productCard(r.p, r.brandName ? { name: r.brandName } : null)),
      categories: cats,
    };
  });

  app.get('/v1/home', async () => {
    const [best, cats, slides, sections] = await Promise.all([
      db
        .select({ p: products, brandName: brands.name })
        .from(products)
        .leftJoin(brands, eq(brands.id, products.brandId))
        .where(and(eq(products.isActive, true), eq(products.isBestseller, true), sql`${products.stockQty} > 0`))
        .orderBy(desc(products.ratingCount))
        .limit(12),
      db
        .select()
        .from(categories)
        .where(and(eq(categories.isActive, true), sql`${categories.parentId} is null`))
        .orderBy(asc(categories.sort))
        .limit(8),
      db
        .select()
        .from(banners)
        .where(
          and(
            eq(banners.isActive, true),
            sql`(${banners.startsAt} is null or ${banners.startsAt} <= now())`,
            sql`(${banners.endsAt} is null or ${banners.endsAt} > now())`,
          ),
        )
        .orderBy(asc(banners.sort), asc(banners.id))
        .limit(10),
      homeSectionCards(db),
    ]);
    return {
      bestsellers: best.map((r) => productCard(r.p, r.brandName ? { name: r.brandName } : null)),
      categories: cats.map((c) => ({ slug: c.slug, name: c.name, imageUrl: c.imageUrl, tint: c.tint })),
      banners: await bannerCards(db, slides),
      sections,
    };
  });

  app.get('/v1/products/:slug', async (req) => {
    const { slug } = parse(z.object({ slug: z.string().min(1).max(200) }), req.params);
    const [row] = await db
      .select({ p: products, brandName: brands.name, categorySlug: categories.slug, categoryName: categories.name })
      .from(products)
      .leftJoin(brands, eq(brands.id, products.brandId))
      .leftJoin(categories, eq(categories.id, products.categoryId))
      .where(and(eq(products.slug, slug), eq(products.isActive, true)));
    if (!row) throw new HttpError(404, 'not_found', 'This product is no longer available.');
    const p = row.p;

    const [variants, related] = await Promise.all([
      p.variantGroup
        ? db
            .select()
            .from(products)
            .where(and(eq(products.variantGroup, p.variantGroup), eq(products.isActive, true)))
            .orderBy(asc(products.pricePaise))
        : Promise.resolve([]),
      p.categoryId
        ? db
            .select({ p: products, brandName: brands.name })
            .from(products)
            .leftJoin(brands, eq(brands.id, products.brandId))
            .where(
              and(
                eq(products.categoryId, p.categoryId),
                ne(products.id, p.id),
                eq(products.isActive, true),
                p.variantGroup ? or(sql`${products.variantGroup} is null`, ne(products.variantGroup, p.variantGroup)) : undefined,
              ),
            )
            .orderBy(desc(products.isBestseller), desc(products.ratingCount))
            .limit(10)
        : Promise.resolve([]),
    ]);

    return {
      ...productCard(p, row.brandName ? { name: row.brandName } : null),
      images: p.images,
      description: htmlToText(p.description),
      specs: p.specs,
      returnable: p.returnable,
      returnDays: p.returnDays,
      category: row.categorySlug ? { slug: row.categorySlug, name: row.categoryName } : null,
      variants: variants.map((v) => ({
        slug: v.slug,
        label: v.variantLabel ?? v.name,
        pricePaise: v.pricePaise,
        inStock: v.stockQty > 0,
        selected: v.id === p.id,
      })),
      related: related.map((r) => productCard(r.p, r.brandName ? { name: r.brandName } : null)),
    };
  });
}
