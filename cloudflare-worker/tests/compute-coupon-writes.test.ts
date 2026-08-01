import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { computeCouponWrites } from '../src/coupon/compute-coupon-writes.js';

const d = (n: number) => new Decimal(n);

const LOYALTY_TIERS: Record<string, Decimal> = {
    ZR4: d(0.04), ZR6: d(0.06), ZR8: d(0.08), ZR10: d(0.10), ZR12: d(0.12),
    ZR14: d(0.14), ZR16: d(0.16), ZR18: d(0.18), ZR20: d(0.20), ZR25: d(0.25)
};

describe('computeCouponWrites', () => {
    it('produces one write item per tier plus one for guests (11 total)', () => {
        const items = computeCouponWrites(
            { code: '123', basePrice: d(100) },
            LOYALTY_TIERS
        );
        expect(items).toHaveLength(11);
        expect(new Set(items.map(i => i.tier)).size).toBe(11);
        expect(items.some(i => i.tier === 'GUEST')).toBe(true);
    });

    describe('GUEST (non-logged-in customers, "Hlavný cenník")', () => {
        it('maps to pricelist ID 1 ("Hlavný cenník")', () => {
            const items = computeCouponWrites({ code: '123', basePrice: d(100) }, LOYALTY_TIERS);
            const guest = items.find(i => i.tier === 'GUEST')!;
            expect(guest.pricelistId).toBe(1);
        });

        it('is capped at 20% same as any non-locked tier (0% loyalty discount -> full 20% coupon room)', () => {
            const items = computeCouponWrites({ code: '123', basePrice: d(100) }, LOYALTY_TIERS);
            const guest = items.find(i => i.tier === 'GUEST')!;
            expect(guest.applyDiscountCoupon).toBe(true);
            expect(guest.minPriceRatio.toNumber()).toBeCloseTo(0.80);
        });

        it('is NEVER blocked by the ZR20/ZR25 lock (Rule 4 must not apply to guests)', () => {
            // No product limit, no action discount — if Rule 4 were wrongly applied to
            // guests (e.g. by matching on an undefined customerTier), this would be
            // blocked. It must not be: guests just get the standard 20% ceiling.
            const items = computeCouponWrites({ code: '123', basePrice: d(100) }, LOYALTY_TIERS);
            const guest = items.find(i => i.tier === 'GUEST')!;
            expect(guest.applyDiscountCoupon).toBe(true);
        });

        it('still respects Rule 1 (product disallows discounts) and Rule 3 (action already >= 20%)', () => {
            const blockedByLimit = computeCouponWrites(
                { code: '123', basePrice: d(100), productMaxDiscount: d(0) },
                LOYALTY_TIERS
            );
            expect(blockedByLimit.find(i => i.tier === 'GUEST')!.applyDiscountCoupon).toBe(false);

            const blockedByAction = computeCouponWrites(
                { code: '123', basePrice: d(100), actionPrice: d(75) }, // 25% action discount
                LOYALTY_TIERS
            );
            expect(blockedByAction.find(i => i.tier === 'GUEST')!.applyDiscountCoupon).toBe(false);
        });

        it('respects an individual productMaxDiscount limit below 20% (Rule 2), same as a logged-in customer would', () => {
            const items = computeCouponWrites(
                { code: '123', basePrice: d(100), productMaxDiscount: d(0.06) },
                LOYALTY_TIERS
            );
            const guest = items.find(i => i.tier === 'GUEST')!;
            // currentDiscount = max(0, 0) = 0 -> remaining = 6% -> minPriceRatio = 0.94
            expect(guest.applyDiscountCoupon).toBe(true);
            expect(guest.minPriceRatio.toNumber()).toBeCloseTo(0.94);
        });
    });

    it('always blocks ZR20/ZR25, regardless of product data', () => {
        const items = computeCouponWrites(
            { code: '123', basePrice: d(100), actionPrice: d(90) },
            LOYALTY_TIERS
        );
        const zr20 = items.find(i => i.tier === 'ZR20')!;
        const zr25 = items.find(i => i.tier === 'ZR25')!;
        expect(zr20.applyDiscountCoupon).toBe(false);
        expect(zr25.applyDiscountCoupon).toBe(false);
        expect(zr20.pricelistId).toBe(26);
        expect(zr25.pricelistId).toBe(29);
        // No room at all for the coupon in these locked tiers.
        expect(zr20.minPriceRatio.toNumber()).toBeCloseTo(1.0);
        expect(zr25.minPriceRatio.toNumber()).toBeCloseTo(1.0);
    });

    it('maps to the correct pricelist IDs for every tier', () => {
        const items = computeCouponWrites({ code: '123', basePrice: d(100) }, LOYALTY_TIERS);
        const byTier = Object.fromEntries(items.map(i => [i.tier, i.pricelistId]));
        expect(byTier).toEqual({
            ZR4: 2, ZR6: 5, ZR8: 8, ZR10: 11, ZR12: 14,
            ZR14: 17, ZR16: 20, ZR18: 23, ZR20: 26, ZR25: 29, GUEST: 1
        });
    });

    it('ZR4 with no action discount and no product limit: coupon room is 20% - 4% = 16%', () => {
        // This is the exact case caught wrong in the first live test: minPriceRatio
        // must be 1 - 0.16 = 0.84 (room for the coupon ON TOP of the tier's own
        // already-discounted pricelist price), NOT 1 - 0.20 (which would double-count
        // the tier discount that pricelist ZR4's price already bakes in).
        const items = computeCouponWrites({ code: '123', basePrice: d(100) }, LOYALTY_TIERS);
        const zr4 = items.find(i => i.tier === 'ZR4')!;
        expect(zr4.applyDiscountCoupon).toBe(true);
        expect(zr4.minPriceRatio.toNumber()).toBeCloseTo(0.84);
    });

    it('derives productDiscount from actionPrice vs basePrice and uses the higher of action/tier', () => {
        // basePrice 100, actionPrice 90 -> 10% action discount. ZR16 tier = 16% > 10%, so tier wins.
        const items = computeCouponWrites(
            { code: '123', basePrice: d(100), actionPrice: d(90) },
            LOYALTY_TIERS
        );
        const zr16 = items.find(i => i.tier === 'ZR16')!;
        // currentDiscount = 16%, ceiling 20% -> coupon's OWN room = 4% -> minPriceRatio = 1 - 0.04 = 0.96
        expect(zr16.applyDiscountCoupon).toBe(true);
        expect(zr16.minPriceRatio.toNumber()).toBeCloseTo(0.96);
    });

    it('respects an individual productMaxDiscount limit below 20%', () => {
        const items = computeCouponWrites(
            { code: '123', basePrice: d(100), productMaxDiscount: d(0.06) },
            LOYALTY_TIERS
        );
        const zr4 = items.find(i => i.tier === 'ZR4')!; // tier discount 4%, limit 6% -> +2% room
        expect(zr4.applyDiscountCoupon).toBe(true);
        // coupon's own room = 2% -> minPriceRatio = 1 - 0.02 = 0.98
        expect(zr4.minPriceRatio.toNumber()).toBeCloseTo(0.98);
    });

    it('when coupon is blocked, minPriceRatio is 1.0000 (no extra room granted)', () => {
        const items = computeCouponWrites(
            { code: '123', basePrice: d(100), actionPrice: d(78) }, // 22% action discount -> Rule 3 blocks
            LOYALTY_TIERS
        );
        const zr4 = items.find(i => i.tier === 'ZR4')!;
        expect(zr4.applyDiscountCoupon).toBe(false);
        expect(zr4.minPriceRatio.toNumber()).toBeCloseTo(1.0);
    });

    describe('brand/category limit fallback (mirrors DiscountLimitPolicy: Product -> Brand -> Category -> None)', () => {
        const BRAND_LIMITS: Record<string, Decimal> = { Apple: d(0.05), Samsung: d(0.10) };
        const CATEGORY_LIMITS: Record<string, Decimal> = { Elektronika: d(0.10) };

        it('falls back to the brand limit when no per-product limit is set', () => {
            const items = computeCouponWrites(
                { code: '123', basePrice: d(100), manufacturer: 'Apple' },
                LOYALTY_TIERS, BRAND_LIMITS, CATEGORY_LIMITS
            );
            const zr4 = items.find(i => i.tier === 'ZR4')!;
            // limit 5%, tier 4% -> remaining 1% -> minPriceRatio = 0.99, NOT the default 20% ceiling.
            expect(zr4.applyDiscountCoupon).toBe(true);
            expect(zr4.minPriceRatio.toNumber()).toBeCloseTo(0.99);
        });

        it('falls back to the category limit when no product or brand limit applies', () => {
            const items = computeCouponWrites(
                { code: '123', basePrice: d(100), category: 'Elektronika' },
                LOYALTY_TIERS, BRAND_LIMITS, CATEGORY_LIMITS
            );
            const zr4 = items.find(i => i.tier === 'ZR4')!;
            // limit 10%, tier 4% -> remaining 6% -> minPriceRatio = 0.94
            expect(zr4.applyDiscountCoupon).toBe(true);
            expect(zr4.minPriceRatio.toNumber()).toBeCloseTo(0.94);
        });

        it('per-product limit takes precedence over brand limit', () => {
            const items = computeCouponWrites(
                { code: '123', basePrice: d(100), manufacturer: 'Apple', productMaxDiscount: d(0.15) },
                LOYALTY_TIERS, BRAND_LIMITS, CATEGORY_LIMITS
            );
            const zr4 = items.find(i => i.tier === 'ZR4')!;
            // product limit 15% wins over Apple's 5% -> remaining 11% -> minPriceRatio = 0.89
            expect(zr4.minPriceRatio.toNumber()).toBeCloseTo(0.89);
        });

        it('brand limit takes precedence over category limit', () => {
            const items = computeCouponWrites(
                { code: '123', basePrice: d(100), manufacturer: 'Apple', category: 'Elektronika' },
                LOYALTY_TIERS, BRAND_LIMITS, CATEGORY_LIMITS
            );
            const zr4 = items.find(i => i.tier === 'ZR4')!;
            // Apple's 5% wins over Elektronika's 10% -> remaining 1% -> minPriceRatio = 0.99
            expect(zr4.minPriceRatio.toNumber()).toBeCloseTo(0.99);
        });

        it('unrecognized brand/category falls through to the default 20% ceiling', () => {
            const items = computeCouponWrites(
                { code: '123', basePrice: d(100), manufacturer: 'SomeOtherBrand', category: 'SomeOtherCategory' },
                LOYALTY_TIERS, BRAND_LIMITS, CATEGORY_LIMITS
            );
            const zr4 = items.find(i => i.tier === 'ZR4')!;
            expect(zr4.minPriceRatio.toNumber()).toBeCloseTo(0.84);
        });
    });

    describe('allowLoyaltyDiscount (e.g. gift cards that must never get a loyalty-tier discount)', () => {
        it('treats tier discount as 0% when allowLoyaltyDiscount is explicitly false', () => {
            const items = computeCouponWrites(
                { code: '123', basePrice: d(100), allowLoyaltyDiscount: false },
                LOYALTY_TIERS
            );
            const zr16 = items.find(i => i.tier === 'ZR16')!;
            // Tier discount ignored -> currentDiscount=0 -> full 20% ceiling available,
            // NOT the 4% remainder a real 16% tier discount would leave.
            expect(zr16.applyDiscountCoupon).toBe(true);
            expect(zr16.minPriceRatio.toNumber()).toBeCloseTo(0.80);
        });

        it('ZR20/ZR25 stay locked regardless of allowLoyaltyDiscount (Rule 4 is about tier identity, not discount magnitude)', () => {
            const items = computeCouponWrites(
                { code: '123', basePrice: d(100), allowLoyaltyDiscount: false },
                LOYALTY_TIERS
            );
            expect(items.find(i => i.tier === 'ZR20')!.applyDiscountCoupon).toBe(false);
            expect(items.find(i => i.tier === 'ZR25')!.applyDiscountCoupon).toBe(false);
        });

        it('defaults to allowed when the field is absent (undefined is not treated as false)', () => {
            const withField = computeCouponWrites({ code: '123', basePrice: d(100), allowLoyaltyDiscount: true }, LOYALTY_TIERS);
            const withoutField = computeCouponWrites({ code: '123', basePrice: d(100) }, LOYALTY_TIERS);
            const zr16a = withField.find(i => i.tier === 'ZR16')!;
            const zr16b = withoutField.find(i => i.tier === 'ZR16')!;
            expect(zr16a.minPriceRatio.toNumber()).toBeCloseTo(zr16b.minPriceRatio.toNumber());
        });
    });

    it('never grants coupon room beyond what the ceiling allows (shop margin safety)', () => {
        const items = computeCouponWrites(
            { code: '123', basePrice: d(100), productMaxDiscount: d(0.10) },
            LOYALTY_TIERS
        );
        for (const item of items) {
            // maxDiscount (1 - minPriceRatio) can never exceed the 10% product limit.
            const couponRoom = new Decimal(1).minus(item.minPriceRatio);
            expect(couponRoom.toNumber()).toBeLessThanOrEqual(0.10 + 1e-9);
        }
    });
});
