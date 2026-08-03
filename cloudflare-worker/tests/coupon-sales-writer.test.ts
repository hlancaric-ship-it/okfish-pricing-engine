import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';
import { CouponSalesWriter } from '../src/coupon/coupon-sales-writer.js';
import { GUEST_PRICELIST_ID } from '../src/coupon/tier-pricelist-map.js';

/**
 * Regression test for a real production incident (2026-08-03): writing coupon
 * fields for the GUEST tier via PATCH /pricelists/1 ("Hlavný cenník") silently
 * overwrote the product's own real "Maximální povolená sleva" cap, because
 * pricelist ID 1 is the same record Shoptet uses for that field — not just
 * another loyalty-tier pricelist. This ran on an automatic 2x-daily cron and
 * corrupted the max-discount cap on every product it touched, twice a day.
 */
describe('CouponSalesWriter — GUEST pricelist protection', () => {
    it('refuses to write to GUEST_PRICELIST_ID (pricelist 1) even when asked', async () => {
        const fakeClient = {
            updatePricelistSalesBatch: vi.fn(),
        } as any;

        const writer = new CouponSalesWriter(fakeClient, { dryRun: false });
        const items = [{ code: 'X1', tier: 'GUEST', pricelistId: GUEST_PRICELIST_ID, applyDiscountCoupon: true, minPriceRatio: new Decimal('0.98') }];

        const stats = await writer.processTierBatch(GUEST_PRICELIST_ID, 'GUEST', items);

        expect(fakeClient.updatePricelistSalesBatch).not.toHaveBeenCalled();
        expect(stats.processed).toBe(0);
    });

    it('still writes normally for a real loyalty-tier pricelist (not GUEST)', async () => {
        const fakeClient = {
            updatePricelistSalesBatch: vi.fn().mockResolvedValue({}),
        } as any;

        const writer = new CouponSalesWriter(fakeClient, { dryRun: false });
        const items = [{ code: 'X1', tier: 'ZR4', pricelistId: 2, applyDiscountCoupon: true, minPriceRatio: new Decimal('0.95') }];

        const stats = await writer.processTierBatch(2, 'ZR4', items);

        expect(fakeClient.updatePricelistSalesBatch).toHaveBeenCalledTimes(1);
        expect(stats.processed).toBe(1);
    });
});
