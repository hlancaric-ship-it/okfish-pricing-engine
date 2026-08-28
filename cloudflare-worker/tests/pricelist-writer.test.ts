import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';
import { PricelistWriter, PricelistDiff } from '../src/shoptet-api/pricelist-writer.js';
import type { ShoptetPricelistItem } from '../src/shoptet-api/client.js';

function fakeItem(price: string): ShoptetPricelistItem {
    return {
        code: 'X',
        currencyCode: 'EUR',
        includingVat: true,
        vatRate: '21',
        price: { price, commonPrice: price, buyPrice: '0', priceRatio: '1' },
        sales: { minPriceRatio: '0', loyaltyDiscount: false, volumeDiscount: false, quantityDiscount: false, discountCoupon: false },
    };
}

function fakeApiClient(overrides: Partial<Record<string, any>> = {}) {
    return {
        updatePricelistBatch: vi.fn(async (pricelistId: number, items: any[]) => ({
            requestId: 'req-1',
            response: '{}',
            timestamp: '2026-08-19T00:00:00.000Z',
            status: 200,
            endpoint: `/pricelists/${pricelistId}`,
        })),
        getPricelistItemByCode: vi.fn(async () => null as ShoptetPricelistItem | null),
        ...overrides,
    } as any;
}

function makeDiff(overrides: Partial<PricelistDiff> = {}): PricelistDiff {
    return {
        code: 'SKU1',
        oldPrice: new Decimal('100.00'),
        newPrice: new Decimal('90.00'),
        ...overrides,
    };
}

describe('PricelistWriter', () => {
    it('returns early with empty stats when there are no diffs', async () => {
        const client = fakeApiClient();
        const writer = new PricelistWriter(client, {});

        const stats = await writer.processDiff(2, 'ZR10', []);

        expect(stats).toMatchObject({ total: 0, processed: 0, failed: 0 });
        expect(client.updatePricelistBatch).not.toHaveBeenCalled();
    });

    it('in dryRun mode, counts all diffs as processed without ever calling the write API', async () => {
        const client = fakeApiClient();
        const writer = new PricelistWriter(client, { dryRun: true });
        const diffs = [makeDiff(), makeDiff({ code: 'SKU2' })];

        const stats = await writer.processDiff(2, 'ZR10', diffs);

        expect(stats.dryRun).toBe(true);
        expect(stats.processed).toBe(2);
        expect(client.updatePricelistBatch).not.toHaveBeenCalled();
    });

    it('splits diffs into batches of 100 and calls updatePricelistBatch once per batch', async () => {
        const client = fakeApiClient();
        const writer = new PricelistWriter(client, {});
        const diffs = Array.from({ length: 250 }, (_, i) => makeDiff({ code: `SKU${i}`, oldPrice: new Decimal('10.00') }));

        const stats = await writer.processDiff(2, 'ZR10', diffs);

        expect(client.updatePricelistBatch).toHaveBeenCalledTimes(3); // 100 + 100 + 50
        expect(stats.processed).toBe(250);
        expect(stats.successfulDiffs).toHaveLength(250);
    });

    it('sends actionPrice in the batch payload only for diffs that define it', async () => {
        const client = fakeApiClient();
        const writer = new PricelistWriter(client, {});
        const diffs = [
            makeDiff({ code: 'SKU1', newActionPrice: new Decimal('75.00') }),
            makeDiff({ code: 'SKU2' }), // newActionPrice undefined -> žádné pole actionPrice v payloadu
        ];

        await writer.processDiff(2, 'ZR10', diffs);

        const [, sentItems] = client.updatePricelistBatch.mock.calls[0];
        expect(sentItems[0]).toEqual({ code: 'SKU1', price: '90.00', actionPrice: '75.00', vatRate: '23.00', includingVat: true });
        expect('actionPrice' in sentItems[1]).toBe(false);
    });

    it('marks the whole chunk as failed when updatePricelistBatch throws, and records the error', async () => {
        const client = fakeApiClient({
            updatePricelistBatch: vi.fn(async () => {
                throw new Error('Shoptet 502');
            }),
        });
        const writer = new PricelistWriter(client, {});
        const diffs = [makeDiff(), makeDiff({ code: 'SKU2' })];

        const stats = await writer.processDiff(2, 'ZR10', diffs);

        expect(stats.failed).toBe(2);
        expect(stats.processed).toBe(0);
        expect(stats.errors[0]).toMatch(/Shoptet 502/);
        expect(stats.successfulDiffs).toHaveLength(0);
    });

    describe('post-write verification for first-time entries (oldPrice === null)', () => {
        it('does NOT verify (no extra GET) for a normal update where oldPrice is already set', async () => {
            const client = fakeApiClient();
            const writer = new PricelistWriter(client, {});
            const diffs = [makeDiff({ oldPrice: new Decimal('100.00') })]; // ne první zápis na ceníku

            await writer.processDiff(2, 'ZR10', diffs);

            expect(client.getPricelistItemByCode).not.toHaveBeenCalled();
        });

        it(
            'verifies a first-time write (oldPrice: null) by reading it back, and does NOT retry when it matches',
            async () => {
                const client = fakeApiClient({
                    getPricelistItemByCode: vi.fn(async () => fakeItem('90.00')),
                });
                const writer = new PricelistWriter(client, {});
                const diffs = [makeDiff({ oldPrice: null, newPrice: new Decimal('90.00') })];

                const stats = await writer.processDiff(2, 'ZR10', diffs);

                expect(client.getPricelistItemByCode).toHaveBeenCalledTimes(1);
                expect(client.updatePricelistBatch).toHaveBeenCalledTimes(1); // jen původní zápis, žádný opravný
                expect(stats.verificationFailures).toHaveLength(0);
            }
        );

        it(
            'regression (INC, 2026-08-14/15): retries and re-verifies a first-time write when Shoptet ' +
            'returned HTTP 200 but silently did not write the price — succeeds on the retry',
            async () => {
                const client = fakeApiClient({
                    getPricelistItemByCode: vi
                        .fn()
                        .mockResolvedValueOnce(null) // první ověření: záznam vůbec neexistuje (tichý no-op)
                        .mockResolvedValueOnce(fakeItem('90.00')), // po opravném zápisu: potvrzeno
                });
                const writer = new PricelistWriter(client, {});
                const diffs = [makeDiff({ oldPrice: null, newPrice: new Decimal('90.00') })];

                const stats = await writer.processDiff(2, 'ZR10', diffs);

                expect(client.updatePricelistBatch).toHaveBeenCalledTimes(2); // původní zápis + opravný
                expect(client.getPricelistItemByCode).toHaveBeenCalledTimes(2);
                expect(stats.verificationFailures).toHaveLength(0);
            }
        );

        it(
            'raises a verificationFailure (fail-closed, not silent) when even the retry write does not stick',
            async () => {
                const client = fakeApiClient({
                    getPricelistItemByCode: vi.fn(async () => null), // nikdy se to nepotvrdí, ani po retry
                });
                const writer = new PricelistWriter(client, {});
                const diffs = [makeDiff({ code: 'SKU-STUCK', oldPrice: null, newPrice: new Decimal('90.00') })];

                const stats = await writer.processDiff(2, 'ZR10', diffs);

                expect(stats.verificationFailures).toEqual([
                    { code: 'SKU-STUCK', expected: '90.00', actual: null },
                ]);
            }
        );

        it('raises a verificationFailure when the retry write itself throws', async () => {
            const client = fakeApiClient({
                getPricelistItemByCode: vi.fn(async () => null),
                updatePricelistBatch: vi
                    .fn()
                    .mockResolvedValueOnce({ requestId: 'r1', response: '{}', timestamp: 't', status: 200, endpoint: '/x' })
                    .mockRejectedValueOnce(new Error('retry write failed: 503')),
            });
            const writer = new PricelistWriter(client, {});
            const diffs = [makeDiff({ code: 'SKU-RETRY-FAIL', oldPrice: null, newPrice: new Decimal('90.00') })];

            const stats = await writer.processDiff(2, 'ZR10', diffs);

            expect(stats.verificationFailures).toEqual([
                { code: 'SKU-RETRY-FAIL', expected: '90.00', actual: null },
            ]);
            // Hlavní dávka pořád počítá jako "processed" -- verifikace je samostatná
            // fail-closed vrstva navíc, ne součást primárního zápisu (viz stats.errors vs.
            // stats.verificationFailures rozlišení v komentáři zdrojového souboru).
            expect(stats.processed).toBe(1);
        });
    });
});
