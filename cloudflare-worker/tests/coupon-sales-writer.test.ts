import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';
import { CouponSalesWriter } from '../src/coupon/coupon-sales-writer.js';
import { GUEST_PRICELIST_ID } from '../src/coupon/tier-pricelist-map.js';

/**
 * Regression coverage for a real production incident (2026-08-03): writing
 * coupon fields for the GUEST tier via PATCH /pricelists/1 ("Hlavný cenník")
 * silently overwrote the product's own real "Maximální povolená sleva" cap,
 * because pricelist ID 1 is the same record Shoptet uses for that field.
 *
 * Original fix (2026-08-03) was a hard block on writing pricelistId=1 at all.
 * Root cause was found and fixed properly on 2026-08-06 instead: the callers
 * (sync-coupon-fields-live.ts / sync-coupon-fields-single-product.ts) were
 * reading the feed's own `maxDiscount` column as GUEST's "coupon room" input —
 * the SAME field this write updates — creating a circular dependency. Once
 * those callers stopped reading that field (productMaxDiscount deliberately
 * left `undefined`, resolved from brandLimits/categoryLimits instead), the
 * circularity is gone and writing GUEST is safe. The write-time block was
 * removed 2026-08-06 (see coupon-sales-writer.ts's own history comment) --
 * this test now asserts THAT intentional state, not the older blanket block.
 */
describe('CouponSalesWriter — GUEST pricelist writes', () => {
    it('writes normally to GUEST_PRICELIST_ID (pricelist 1) — the circular-dependency root cause is fixed upstream, not by blocking this write', async () => {
        const fakeClient = {
            updatePricelistSalesBatch: vi.fn().mockResolvedValue({}),
            // 2026-08-15: post-write verification (see coupon-sales-writer.ts) reads
            // the item back — mock it as matching, so the test isn't asserting the
            // retry path it isn't exercising.
            getPricelistItemByCode: vi.fn().mockResolvedValue({
                code: 'X1',
                sales: { discountCoupon: true, minPriceRatio: '0.9800', loyaltyDiscount: true, volumeDiscount: true, quantityDiscount: true }
            }),
        } as any;

        const writer = new CouponSalesWriter(fakeClient, { dryRun: false });
        const items = [{ code: 'X1', tier: 'GUEST', pricelistId: GUEST_PRICELIST_ID, applyDiscountCoupon: true, minPriceRatio: new Decimal('0.98') }];

        const stats = await writer.processTierBatch(GUEST_PRICELIST_ID, 'GUEST', items);

        expect(fakeClient.updatePricelistSalesBatch).toHaveBeenCalledTimes(1);
        expect(stats.processed).toBe(1);
        expect(stats.verificationFailures).toHaveLength(0);
    });

    it('still writes normally for a real loyalty-tier pricelist (not GUEST)', async () => {
        const fakeClient = {
            updatePricelistSalesBatch: vi.fn().mockResolvedValue({}),
            getPricelistItemByCode: vi.fn().mockResolvedValue({
                code: 'X1',
                sales: { discountCoupon: true, minPriceRatio: '0.9500', loyaltyDiscount: true, volumeDiscount: true, quantityDiscount: true }
            }),
        } as any;

        const writer = new CouponSalesWriter(fakeClient, { dryRun: false });
        const items = [{ code: 'X1', tier: 'ZR4', pricelistId: 2, applyDiscountCoupon: true, minPriceRatio: new Decimal('0.95') }];

        const stats = await writer.processTierBatch(2, 'ZR4', items);

        expect(fakeClient.updatePricelistSalesBatch).toHaveBeenCalledTimes(1);
        expect(stats.processed).toBe(1);
        expect(stats.verificationFailures).toHaveLength(0);
    });
});
