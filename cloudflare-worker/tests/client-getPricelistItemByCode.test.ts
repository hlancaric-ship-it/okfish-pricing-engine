import { describe, it, expect, vi, afterEach } from 'vitest';
import { ShoptetApiClient } from '../src/shoptet-api/client';

// Real shape observed live 2026-08-21 against GET /pricelists/{id}?code=X --
// `data.pricelist` is an array directly (one item, filtered by code), NOT
// `data.pricelist.items`. getPricelistItemByCode() previously read
// `result.data?.pricelist?.items`, which is always undefined against this
// real shape -- verification for every first-time price write silently
// always "failed" (CHYBÍ ZÁZNAM), even when the write succeeded, which
// froze sync.yml's lastSync from 2026-08-19 onward (isSuccess requires
// verificationFailures.length === 0).
const REAL_RESPONSE = {
    data: {
        pricelist: [
            {
                code: '39373',
                currencyCode: 'EUR',
                includingVat: true,
                vatRate: '23.00',
                price: { price: '40.76', commonPrice: null, buyPrice: null, priceRatio: '1.000', actionPrice: null },
                sales: { minPriceRatio: '0.000', freeShipping: false, freeBilling: false, loyaltyDiscount: false, volumeDiscount: false, quantityDiscount: false, discountCoupon: false },
                orderableAmount: { minimumAmount: null, maximumAmount: null },
                prices: { purchasePrice: { price: null, vatRate: '23.00', includingVat: true } }
            }
        ],
        paginator: { totalCount: 1, page: 1, pageCount: 1, itemsOnPage: 1, itemsPerPage: 100 }
    },
    errors: null,
    metadata: { requestId: 'test' }
};

describe('ShoptetApiClient.getPricelistItemByCode', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('parses the real API shape (data.pricelist as array) and returns the item', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => REAL_RESPONSE
        } as any));

        const client = new ShoptetApiClient('fake-token');
        const item = await client.getPricelistItemByCode(2, '39373');

        expect(item).not.toBeNull();
        expect(item?.code).toBe('39373');
        expect(item?.price.price).toBe('40.76');

        vi.unstubAllGlobals();
    });

    it('returns null when the code truly has no record (empty array)', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ data: { pricelist: [], paginator: { totalCount: 0, page: 1, pageCount: 1, itemsOnPage: 0, itemsPerPage: 100 } }, errors: null, metadata: {} })
        } as any));

        const client = new ShoptetApiClient('fake-token');
        const item = await client.getPricelistItemByCode(2, 'nonexistent');

        expect(item).toBeNull();

        vi.unstubAllGlobals();
    });
});
