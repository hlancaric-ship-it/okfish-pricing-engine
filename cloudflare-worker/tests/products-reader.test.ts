import { describe, it, expect, vi } from 'vitest';
import { ProductsReader } from '../src/shoptet-api/products-reader.js';

// Isolate these tests from the repo's real force-sync-products.json (loadForceSyncEntries
// reads it via process.cwd()) -- without this, whatever happens to be listed there at
// test-run time (e.g. real incident codes 99459/103525) leaks into every test's
// incompleteCodes/products, unrelated to what the test itself sets up.
vi.mock('fs', () => ({ existsSync: () => false, readFileSync: () => '[]' }));

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

        const { products, incompleteCodes } = await reader.fetchProducts(BASE_PRICELIST_ID, undefined, '2026-08-01T00:00:00+0000');

        expect(products).toHaveLength(1);
        expect(incompleteCodes).toHaveLength(0);
        expect(products[0].price.toNumber()).toBe(650);
        expect(products[0].productMaxDiscount).toBeDefined();
        expect(products[0].productMaxDiscount!.toNumber()).toBeCloseTo(0.05);
    });

    it('reads the actionPrice from the same pricelist entry when present', async () => {
        const reader = new ProductsReader(fakeClient([
            { pricelistId: BASE_PRICELIST_ID, price: { price: '650.00', actionPrice: { price: '500.00' } }, sales: { minPriceRatio: 0.95 } },
        ]));

        const { products } = await reader.fetchProducts(BASE_PRICELIST_ID, undefined, '2026-08-01T00:00:00+0000');

        expect(products[0].actionPrice).toBeDefined();
        expect(products[0].actionPrice!.toNumber()).toBe(500);
    });

    // Regression test for INCIDENT 2026-08-12 (99459, 103525): a product changed
    // (e.g. just created) but Shoptet hasn't yet propagated it into perPricelistPrices
    // for the base pricelist. The old code fabricated basePrice=0 and wrote that as a
    // real price -- silently. The fix: exclude the product from this run's results
    // entirely and report it via incompleteCodes, so the orchestrator can refuse to
    // advance lastSync and retry it on the next run instead of losing it forever.
    it('excludes the product and reports it via incompleteCodes when the pricelist entry is missing entirely (does NOT fabricate price=0)', async () => {
        const reader = new ProductsReader(fakeClient([
            { pricelistId: 999, price: { price: '1000.00' }, sales: { minPriceRatio: 0.5 } }, // only a foreign pricelist present
        ]));

        const { products, incompleteCodes } = await reader.fetchProducts(BASE_PRICELIST_ID, undefined, '2026-08-01T00:00:00+0000');

        expect(products).toHaveLength(0);
        expect(incompleteCodes).toEqual(['SKU-1']);
    });

    // Regression test for INC-010 follow-up (2026-08-13): fetchProducts() used to
    // `return` immediately when getProductChanges() reported zero changes, BEFORE
    // ever reaching the force-sync-products.json escape-hatch loop below it. Since
    // 99459/103525 never appear in /products/changes at all, every incremental run
    // with zero unrelated changes silently skipped force-syncing them entirely --
    // while sync-orchestrator.ts still cleared force-sync-products.json afterwards
    // as "successfully processed". Confirmed live: run 31684237852 (2026-08-13
    // 09:00 UTC) logged "Products loaded: 0" and no "[ForceSync] Doplňuji produkt"
    // line, yet still cleared the file. Fix: the force-sync loop must run
    // regardless of how many (if any) regular changes were found.
    it('still processes force-sync entries even when getProductChanges() returns zero changes', async () => {
        vi.doMock('fs', () => ({
            existsSync: () => true,
            readFileSync: () => JSON.stringify([{ code: 'FORCE-1', guid: 'force-guid-1' }]),
        }));
        vi.resetModules();
        const { ProductsReader: FreshProductsReader } = await import('../src/shoptet-api/products-reader.js');

        const client = {
            getProductChanges: async () => [],
            getProductDetail: async () => ({
                code: 'FORCE-1',
                perPricelistPrices: [
                    { pricelistId: BASE_PRICELIST_ID, price: { price: '199.00' }, sales: { minPriceRatio: 0.9 } },
                ],
            }),
        } as any;

        const reader = new FreshProductsReader(client);
        const { products, incompleteCodes } = await reader.fetchProducts(BASE_PRICELIST_ID, undefined, '2026-08-01T00:00:00+0000');

        expect(incompleteCodes).toHaveLength(0);
        expect(products).toHaveLength(1);
        expect(products[0].code).toBe('FORCE-1');
        expect(products[0].price.toNumber()).toBe(199);

        vi.doUnmock('fs');
        vi.resetModules();
    });
});
