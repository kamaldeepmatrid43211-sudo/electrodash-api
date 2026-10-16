import { describe, expect, it } from 'vitest';

import { evaluateCoupon, quote, type PricingCoupon, type PricingProduct } from '../src/lib/pricing.js';

const fees = { deliveryFeePaise: 2500, freeDeliveryMinPaise: 19900, handlingFeePaise: 500, codFeePaise: 1000 };

function product(over: Partial<PricingProduct> = {}): PricingProduct {
  return {
    id: 1,
    name: '9W LED Bulb',
    pricePaise: 9900,
    mrpPaise: 15000,
    stockQty: 50,
    maxPerOrder: 10,
    isActive: true,
    categoryId: 1,
    ...over,
  };
}

function coupon(over: Partial<PricingCoupon> = {}): PricingCoupon {
  return {
    code: 'DASH20',
    title: '20% off your first order',
    type: 'percent',
    value: 20,
    maxDiscountPaise: 10000,
    minOrderPaise: 29900,
    firstOrderOnly: true,
    categoryId: null,
    validUntil: null,
    isActive: true,
    ...over,
  };
}

describe('quote', () => {
  it('reproduces the mockup cart: ₹737 items, free delivery, ₹5 handling, DASH20 −₹100 → ₹642', () => {
    const q = quote({
      lines: [
        { product: product({ id: 1, pricePaise: 49900, mrpPaise: 79900 }), qty: 1 },
        { product: product({ id: 2, pricePaise: 14900, mrpPaise: 21000 }), qty: 1 },
        { product: product({ id: 3, pricePaise: 8900, mrpPaise: 12000 }), qty: 1 },
      ],
      fees,
      coupon: coupon(),
      isFirstOrder: true,
    });
    expect(q.subtotalPaise).toBe(73700);
    expect(q.mrpTotalPaise).toBe(112900);
    expect(q.deliveryFeePaise).toBe(0);
    expect(q.deliveryFeeBeforeWaiverPaise).toBe(2500);
    expect(q.handlingFeePaise).toBe(500);
    expect(q.discountPaise).toBe(10000); // 20% = ₹147.40, capped at ₹100
    expect(q.totalPaise).toBe(64200);
    expect(q.savingsPaise).toBe(112900 - 73700 + 10000 + 2500);
    expect(q.blocking).toBe(false);
  });

  it('charges delivery below the free-delivery threshold', () => {
    const q = quote({ lines: [{ product: product(), qty: 1 }], fees, isFirstOrder: false });
    expect(q.deliveryFeePaise).toBe(2500);
    expect(q.totalPaise).toBe(9900 + 2500 + 500);
  });

  it('adds the COD fee only for cash on delivery', () => {
    const lines = [{ product: product(), qty: 3 }];
    expect(quote({ lines, fees, paymentMethod: 'cod', isFirstOrder: false }).codFeePaise).toBe(1000);
    expect(quote({ lines, fees, paymentMethod: 'online', isFirstOrder: false }).codFeePaise).toBe(0);
  });

  it('excludes unavailable items from totals and blocks checkout', () => {
    const q = quote({
      lines: [
        { product: product({ id: 1 }), qty: 2 },
        { product: product({ id: 2, stockQty: 0 }), qty: 1 },
      ],
      fees,
      isFirstOrder: false,
    });
    expect(q.subtotalPaise).toBe(19800);
    expect(q.lines[1].issue).toEqual({ code: 'unavailable' });
    expect(q.blocking).toBe(true);
  });

  it('flags quantities above stock or the per-order limit', () => {
    const q = quote({
      lines: [
        { product: product({ id: 1, stockQty: 2 }), qty: 3 },
        { product: product({ id: 2, maxPerOrder: 5 }), qty: 6 },
      ],
      fees,
      isFirstOrder: false,
    });
    expect(q.lines[0].issue).toEqual({ code: 'insufficient_stock', available: 2 });
    expect(q.lines[1].issue).toEqual({ code: 'over_limit', max: 5 });
    expect(q.blocking).toBe(true);
  });

  it('returns zero fees for an empty cart', () => {
    const q = quote({ lines: [], fees, paymentMethod: 'cod', isFirstOrder: true });
    expect(q.totalPaise).toBe(0);
  });

  it('reports an unknown coupon code', () => {
    const q = quote({ lines: [{ product: product(), qty: 1 }], fees, unknownCouponCode: 'NOPE', isFirstOrder: true });
    expect(q.coupon).toEqual({ code: 'NOPE', applied: false, reason: 'This coupon code is not valid.' });
  });

  it('applies a free-delivery coupon', () => {
    const q = quote({
      lines: [{ product: product(), qty: 1 }],
      fees,
      coupon: coupon({ code: 'FREEDEL', type: 'free_delivery', value: 0, minOrderPaise: 0, firstOrderOnly: false }),
      isFirstOrder: false,
    });
    expect(q.deliveryFeePaise).toBe(0);
    expect(q.discountPaise).toBe(0);
  });
});

describe('evaluateCoupon', () => {
  const lines = [{ product: product({ pricePaise: 20000 }), qty: 1 }];
  const ctx = { isFirstOrder: true, now: new Date('2026-10-13T10:00:00Z') };

  it('explains how much more to add for the minimum order', () => {
    expect(evaluateCoupon(coupon({ minOrderPaise: 29900 }), lines, ctx)).toMatchObject({
      applied: false,
      reason: 'Add ₹99 more to use this coupon.',
    });
  });

  it('rejects first-order coupons on repeat orders', () => {
    expect(evaluateCoupon(coupon({ minOrderPaise: 0 }), lines, { ...ctx, isFirstOrder: false })).toMatchObject({
      applied: false,
    });
  });

  it('rejects expired and inactive coupons', () => {
    expect(evaluateCoupon(coupon({ validUntil: new Date('2026-01-01') }), lines, ctx)).toMatchObject({ applied: false });
    expect(evaluateCoupon(coupon({ isActive: false }), lines, ctx)).toMatchObject({ applied: false });
  });

  it('limits category coupons to items in that category', () => {
    const mixed = [
      { product: product({ id: 1, pricePaise: 30000, categoryId: 1 }), qty: 1 },
      { product: product({ id: 2, pricePaise: 50000, categoryId: 2 }), qty: 1 },
    ];
    const r = evaluateCoupon(
      coupon({ code: 'BULB15', value: 15, maxDiscountPaise: 7500, minOrderPaise: 29900, firstOrderOnly: false, categoryId: 1 }),
      mixed,
      ctx,
    );
    expect(r).toMatchObject({ applied: true, discountPaise: 4500 }); // 15% of ₹300 only

    // A product whose main category is 2 but which is also listed in category 1 qualifies too.
    const alsoListed = [mixed[0], { product: product({ id: 2, pricePaise: 50000, categoryId: 2, categoryIds: [2, 1] }), qty: 1 }];
    const r2 = evaluateCoupon(
      coupon({ code: 'BULB15', value: 15, maxDiscountPaise: 20000, minOrderPaise: 29900, firstOrderOnly: false, categoryId: 1 }),
      alsoListed,
      ctx,
    );
    expect(r2).toMatchObject({ applied: true, discountPaise: 12000 }); // 15% of ₹800
  });

  it('never discounts more than the eligible amount for flat coupons', () => {
    const r = evaluateCoupon(coupon({ type: 'flat', value: 50000, minOrderPaise: 0, maxDiscountPaise: null }), lines, ctx);
    expect(r).toMatchObject({ applied: true, discountPaise: 20000 });
  });
});
