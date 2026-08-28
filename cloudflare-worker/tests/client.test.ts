import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ShoptetApiClient, GlobalStats } from '../src/shoptet-api/client.js';

function jsonResponse(status: number, body: any, headers: Record<string, string> = {}): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        url: 'https://api.myshoptet.com/api/test',
        headers: new Headers(headers),
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

describe('ShoptetApiClient', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('throws immediately if constructed without a token', () => {
        expect(() => new ShoptetApiClient('')).toThrow(/token chybí/i);
    });

    it('getPricelists returns the pricelists array on success', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse(200, { data: { pricelists: [{ id: 1, name: 'GUEST' }, { id: 2, name: 'ZR4' }] } })
        );
        const client = new ShoptetApiClient('fake-token');

        const result = await client.getPricelists();

        expect(result).toEqual([{ id: 1, name: 'GUEST' }, { id: 2, name: 'ZR4' }]);
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.myshoptet.com/api/pricelists',
            expect.objectContaining({ headers: expect.objectContaining({ 'Shoptet-Private-API-Token': 'fake-token' }) })
        );
    });

    it('throws a descriptive error when the API responds with an errors[] payload', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, { errors: [{ message: 'boom' }] }));
        const client = new ShoptetApiClient('fake-token');

        await expect(client.getPricelists()).rejects.toThrow(/API chyba/);
    });

    it('getProductDetail returns null on 404 (product deleted) instead of throwing', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(404, { errors: [{ message: 'not found' }] }));
        const client = new ShoptetApiClient('fake-token');

        const result = await client.getProductDetail('some-guid');

        expect(result).toBeNull();
    });

    it(
        'getProductDetail returns json.data directly (regression: Shoptet has no nested json.data.product — ' +
        'INC-010, this function silently returned undefined for every product for 12 days in production)',
        async () => {
            const productPayload = { guid: 'g1', type: 'product', variants: [{ code: 'SKU1' }] };
            fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: productPayload }));
            const client = new ShoptetApiClient('fake-token');

            const result = await client.getProductDetail('g1');

            expect(result).toEqual(productPayload);
        }
    );

    it(
        'updatePricelistBatch nests actionPrice under price (regression: actionPrice used to be silently ' +
        'dropped from the PATCH body because it was set as a sibling of price, not nested under it)',
        async () => {
            fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: {} }, { 'x-request-id': 'req-1' }));
            const client = new ShoptetApiClient('fake-token');

            await client.updatePricelistBatch(1, [{ code: 'SKU1', price: '100.00', actionPrice: '80.00' }]);

            const [, requestInit] = fetchMock.mock.calls[0];
            const sentBody = JSON.parse(requestInit.body);
            expect(sentBody).toEqual({
                data: [{ code: 'SKU1', price: { price: '100.00', actionPrice: { price: '80.00' } } }],
            });
        }
    );

    it('updatePricelistBatch sends actionPrice: null to explicitly clear a previously set action price', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: {} }));
        const client = new ShoptetApiClient('fake-token');

        await client.updatePricelistBatch(1, [{ code: 'SKU1', price: '100.00', actionPrice: null }]);

        const [, requestInit] = fetchMock.mock.calls[0];
        const sentBody = JSON.parse(requestInit.body);
        expect(sentBody.data[0].price.actionPrice).toBeNull();
    });

    it('updatePricelistBatch omits actionPrice entirely when not provided (partial-update semantics)', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: {} }));
        const client = new ShoptetApiClient('fake-token');

        await client.updatePricelistBatch(1, [{ code: 'SKU1', price: '100.00' }]);

        const [, requestInit] = fetchMock.mock.calls[0];
        const sentBody = JSON.parse(requestInit.body);
        expect(sentBody.data[0].price).toEqual({ price: '100.00' });
        expect('actionPrice' in sentBody.data[0].price).toBe(false);
    });

    it('fetchPaginated (via getCustomers) walks every page and concatenates items', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse(200, {
                data: { customers: [{ guid: 'c1' }], paginator: { pageCount: 2 } },
            }))
            .mockResolvedValueOnce(jsonResponse(200, {
                data: { customers: [{ guid: 'c2' }], paginator: { pageCount: 2 } },
            }));
        const client = new ShoptetApiClient('fake-token');

        const result = await client.getCustomers();

        expect(result).toEqual([{ guid: 'c1' }, { guid: 'c2' }]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('fetchPaginated stops early once maxPages is reached, without fetching further pages', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, {
            data: { customers: [{ guid: 'c1' }], paginator: { pageCount: 5 } },
        }));
        const client = new ShoptetApiClient('fake-token');

        const result = await client.getCustomers(1);

        expect(result).toEqual([{ guid: 'c1' }]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it(
        'fetchPaginated matches item count against paginator.totalCount when present (regression: INC-012, ' +
        'pagination-during-mutation silently dropped a whole page of items with no error)',
        async () => {
            fetchMock
                .mockResolvedValueOnce(jsonResponse(200, {
                    data: { customers: [{ guid: 'c1' }], paginator: { pageCount: 2, totalCount: 2 } },
                }))
                .mockResolvedValueOnce(jsonResponse(200, {
                    data: { customers: [{ guid: 'c2' }], paginator: { pageCount: 2, totalCount: 2 } },
                }));
            const client = new ShoptetApiClient('fake-token');

            const result = await client.getCustomers();

            expect(result).toEqual([{ guid: 'c1' }, { guid: 'c2' }]);
            expect(fetchMock).toHaveBeenCalledTimes(2);
        }
    );

    it(
        'fetchPaginated retries the whole pull when concatenated items fall short of paginator.totalCount, ' +
        'and succeeds once a later attempt is consistent (INC-012 fix)',
        async () => {
            // Attempt 1: page 2 silently loses an item mid-pull (2 items, totalCount says 3).
            fetchMock
                .mockResolvedValueOnce(jsonResponse(200, {
                    data: { customers: [{ guid: 'c1' }], paginator: { pageCount: 2, totalCount: 3 } },
                }))
                .mockResolvedValueOnce(jsonResponse(200, {
                    data: { customers: [{ guid: 'c2' }], paginator: { pageCount: 2, totalCount: 3 } },
                }))
                // Attempt 2: consistent full pull.
                .mockResolvedValueOnce(jsonResponse(200, {
                    data: { customers: [{ guid: 'c1' }], paginator: { pageCount: 2, totalCount: 3 } },
                }))
                .mockResolvedValueOnce(jsonResponse(200, {
                    data: { customers: [{ guid: 'c2' }, { guid: 'c3' }], paginator: { pageCount: 2, totalCount: 3 } },
                }));
            const client = new ShoptetApiClient('fake-token');

            const result = await client.getCustomers();

            expect(result).toEqual([{ guid: 'c1' }, { guid: 'c2' }, { guid: 'c3' }]);
            expect(fetchMock).toHaveBeenCalledTimes(4);
        }
    );

    it(
        'fetchPaginated throws (instead of silently returning incomplete data) after exhausting integrity retries',
        async () => {
            // All 3 attempts stay short of totalCount.
            fetchMock.mockResolvedValue(jsonResponse(200, {
                data: { customers: [{ guid: 'c1' }], paginator: { pageCount: 1, totalCount: 5 } },
            }));
            const client = new ShoptetApiClient('fake-token');

            await expect(client.getCustomers()).rejects.toThrow(/integrit/i);
            expect(fetchMock).toHaveBeenCalledTimes(3);
        }
    );

    it('fetchPaginated skips the integrity check for a maxPages-truncated (intentionally partial) pull', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, {
            data: { customers: [{ guid: 'c1' }], paginator: { pageCount: 5, totalCount: 5000 } },
        }));
        const client = new ShoptetApiClient('fake-token');

        const result = await client.getCustomers(1);

        expect(result).toEqual([{ guid: 'c1' }]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('getPricelistItemByCode returns null when the pricelist has no entry for that code', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { pricelist: { items: [] } } }));
        const client = new ShoptetApiClient('fake-token');

        const result = await client.getPricelistItemByCode(1, 'MISSING-CODE');

        expect(result).toBeNull();
    });

    it('updateNegativeStockAllowed PATCHes the correct endpoint with the variant payload', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: {} }, { 'x-request-id': 'req-9' }));
        const client = new ShoptetApiClient('fake-token');

        const result = await client.updateNegativeStockAllowed('SKU1', true);

        const [url, requestInit] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.myshoptet.com/api/products/code/SKU1');
        expect(requestInit.method).toBe('PATCH');
        expect(JSON.parse(requestInit.body)).toEqual({ data: { variants: [{ code: 'SKU1', negativeStockAllowed: true }] } });
        expect(result.requestId).toBe('req-9');
    });

    it('tracks GlobalStats.apiRequests.GET / PATCH counts across calls', async () => {
        GlobalStats.apiRequests.GET = 0;
        GlobalStats.apiRequests.PATCH = 0;
        fetchMock
            .mockResolvedValueOnce(jsonResponse(200, { data: { pricelists: [] } }))
            .mockResolvedValueOnce(jsonResponse(200, { data: {} }));
        const client = new ShoptetApiClient('fake-token');

        await client.getPricelists();
        await client.updatePricelistBatch(1, [{ code: 'SKU1', price: '10.00' }]);

        expect(GlobalStats.apiRequests.GET).toBe(1);
        expect(GlobalStats.apiRequests.PATCH).toBe(1);
    });

    it('terminates pagination immediately in 1 request when entity is empty (totalCount: 0)', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, {
            data: {
                orders: [],
                paginator: { page: 1, pageCount: 0, totalCount: 0 }
            }
        }));
        const client = new ShoptetApiClient('fake-token');

        const orders = await client.getCustomerOrders('cust-no-orders');
        expect(orders).toEqual([]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('terminates pagination immediately when page 1 returns empty items (throws integrity mismatch on full pull)', async () => {
        fetchMock.mockResolvedValue(jsonResponse(200, {
            data: {
                orders: [],
                paginator: { page: 1, pageCount: 5, totalCount: 50 }
            }
        }));
        const client = new ShoptetApiClient('fake-token');

        // fetchPaginated with mismatch retry will retry MAX_INTEGRITY_RETRIES times and throw
        // verifying it safely breaks without looping indefinitely within any single run
        await expect(client.getCustomerOrders('cust-empty-page')).rejects.toThrow(/integrita dat/);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('shares GlobalStats singleton across global scope', () => {
        const symbolKey = Symbol.for('__SHOPTET_GLOBAL_STATS__');
        const globalRef = (globalThis as any)[symbolKey];
        expect(globalRef).toBeDefined();
        expect(globalRef).toBe(GlobalStats);
    });
});

