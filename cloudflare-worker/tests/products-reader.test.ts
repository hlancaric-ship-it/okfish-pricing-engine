import { describe, it, expect } from 'vitest';
import { ProductsReader } from '../src/shoptet-api/products-reader.js';

const BASE_PRICELIST_ID = 1;

/**
 * Regression test for a real production bug: the incremental sync path read
 * `detail.price` / `detail.sales.minPriceRatio` directly on the product-detail
 * response — fields that don't exist there per the Shoptet OpenAPI schema. Real
 * price data (including `sales.minPriceRatio`, the product's own max-discount
 * cap) only exists inside `detail.perPricelistPrices[]`, one entry per pricelist,
 * requested via `?include=perPricelistPrices`. Because the old code silently read
 * `undefined`, ANY product touched after the last full sync lost its max-discount
 * cap — loyalty tiers (e.g. ZR25 = 25%) then applied uncapped instead of being
 * clamped to the product's real limit (e.g. 5%).
 */
function fakeClient(perPricelistPrices: any[]) {
    return {
        getProductChanges: async () => [{ guid: 'guid-1', code: 'SKU-1', changeType: 'update' }],
        getProductDetail: async () => ({
            code: 'SKU-1',
            perPricelistPrices,
        }),
    } as any;
}

describe('ProductsReader — incremental sync price/maxDiscount extraction', () => {
    it('reads price and productMaxDiscount from the perPricelistPrices entry matching the base pricelist', async () => {
        const reader = new ProductsReader(fakeClient([
            { pricelistId: 999, price: { price: '1000.00' }, sales: { minPriceRatio: 0.5 } }, // wrong pricelist, must be ignored
            { pricelistId: BASE_PRICELIST_ID, price: { price: '650.00' }, sales: { minPriceRatio: 0.95 } }, // 5% max discount
        ]));

        const products = await reader.fetchProducts(BASE_PRICELIST_ID, undefined, '2026-08-01T00:00:00+0000');

        expect(products).toHaveLength(1);
        expect(products[0].price.toNumber()).toBe(650);
        expect(products[0].productMaxDiscount).toBeDefined();
        expect(products[0].productMaxDiscount!.toNumber()).toBeCloseTo(0.05);
    });

    it('reads the actionPrice from the same pricelist entry when present', async () => {
        const reader = new ProductsReader(fakeClient([
            { pricelistId: BASE_PRICELIST_ID, price: { price: '650.00', actionPrice: { price: '500.00' } }, sales: { minPriceRatio: 0.95 } },
        ]));

        const products = await reader.fetchProducts(BASE_PRICELIST_ID, undefined, '2026-08-01T00:00:00+0000');

        expect(products[0].actionPrice).toBeDefined();
        expect(products[0].actionPrice!.toNumber()).toBe(500);
    });

    it('leaves productMaxDiscount undefined (not a wrong 0) when the pricelist entry for this product is missing entirely', async () => {
        const reader = new ProductsReader(fakeClient([
            { pricelistId: 999, price: { price: '1000.00' }, sales: { minPriceRatio: 0.5 } }, // only a foreign pricelist present
        ]));

        const products = await reader.fetchProducts(BASE_PRICELIST_ID, undefined, '2026-08-01T00:00:00+0000');

        expect(products).toHaveLength(1);
        expect(products[0].price.toNumber()).toBe(0);
        expect(products[0].productMaxDiscount).toBeUndefined();
    });
});
