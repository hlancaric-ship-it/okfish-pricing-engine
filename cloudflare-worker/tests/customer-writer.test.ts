import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CustomerWriter, CustomerDiff } from '../src/shoptet-api/customer-writer.js';
import { GlobalStats } from '../src/shoptet-api/client.js';
import type { ICustomerCache } from '../src/shoptet-api/customer-cache.js';

function fakeApiClient(overrides: Partial<Record<string, any>> = {}) {
    return {
        updateCustomerGroup: vi.fn(async (guid: string, pricelistId: number) => ({
            requestId: 'req-1',
            response: '{}',
            timestamp: '2026-08-19T00:00:00.000Z',
            status: 200,
            endpoint: `/customers/${guid}`,
        })),
        getCustomerDetail: vi.fn(async () => ({ accounts: [{ email: 'zakaznik@example.test' }] })),
        ...overrides,
    } as any;
}

function makeDiff(overrides: Partial<CustomerDiff> = {}): CustomerDiff {
    return {
        customerGuid: 'guid-1',
        customerName: 'Jan Novák',
        oldTier: 'ZR4',
        newTier: 'ZR10',
        oldPricelistId: 2,
        newPricelistId: -1, // dopočítá se z pricelistNameMap uvnitř processDiff
        ...overrides,
    };
}

describe('CustomerWriter', () => {
    beforeEach(() => {
        GlobalStats.auditLogs = 0;
    });

    it('returns early with empty stats when there are no diffs', async () => {
        const client = fakeApiClient();
        const writer = new CustomerWriter(client, { pricelistNameMap: { ZR10: 27 } });

        const stats = await writer.processDiff([]);

        expect(stats).toMatchObject({ total: 0, processed: 0, failed: 0, skipped: 0 });
        expect(client.updateCustomerGroup).not.toHaveBeenCalled();
    });

    it('fails (not crashes) a diff whose tier is missing from pricelistNameMap, and continues processing the rest', async () => {
        const client = fakeApiClient();
        const writer = new CustomerWriter(client, { pricelistNameMap: { ZR10: 27 }, dryRun: true });
        const diffs = [makeDiff({ newTier: 'ZR99-DOES-NOT-EXIST' }), makeDiff({ customerGuid: 'guid-2' })];

        const stats = await writer.processDiff(diffs);

        expect(stats.failed).toBe(1);
        expect(stats.errors[0]).toMatch(/pricelistNameMap/);
        // druhý diff (platný tier) se přesto zpracoval -- jeden špatný záznam nesmí utopit zbytek dávky
        expect(stats.processed).toBe(1);
    });

    it('skips a diff whose old and new pricelist id are already identical, without calling the API', async () => {
        const client = fakeApiClient();
        const writer = new CustomerWriter(client, { pricelistNameMap: { ZR10: 27 } });
        const diffs = [makeDiff({ oldPricelistId: 27, newTier: 'ZR10' })];

        const stats = await writer.processDiff(diffs);

        expect(stats.skipped).toBe(1);
        expect(client.updateCustomerGroup).not.toHaveBeenCalled();
    });

    it('in dryRun mode, counts diffs as processed without ever calling the write API', async () => {
        const client = fakeApiClient();
        const writer = new CustomerWriter(client, { pricelistNameMap: { ZR10: 27 }, dryRun: true });
        const diffs = [makeDiff()];

        const stats = await writer.processDiff(diffs);

        expect(stats.dryRun).toBe(true);
        expect(stats.processed).toBe(1);
        expect(client.updateCustomerGroup).not.toHaveBeenCalled();
    });

    it('writes a live diff, resolves the pricelist id, and logs an audit entry', async () => {
        const client = fakeApiClient();
        const writer = new CustomerWriter(client, { pricelistNameMap: { ZR10: 27 } });
        const diffs = [makeDiff()];

        const stats = await writer.processDiff(diffs);

        expect(stats.processed).toBe(1);
        expect(stats.failed).toBe(0);
        expect(client.updateCustomerGroup).toHaveBeenCalledWith('guid-1', 27, undefined);
        expect(GlobalStats.auditLogs).toBe(1);
    });

    it('passes the customerGroupMap code through to updateCustomerGroup when configured', async () => {
        const client = fakeApiClient();
        const writer = new CustomerWriter(client, {
            pricelistNameMap: { ZR10: 27 },
            customerGroupMap: { ZR10: 'zr10' },
        });

        await writer.processDiff([makeDiff()]);

        expect(client.updateCustomerGroup).toHaveBeenCalledWith('guid-1', 27, 'zr10');
    });

    it('captures a failed write as stats.failed with the error message, and does not throw out of processDiff', async () => {
        const client = fakeApiClient({
            updateCustomerGroup: vi.fn(async () => {
                throw new Error('Shoptet 500');
            }),
        });
        const writer = new CustomerWriter(client, { pricelistNameMap: { ZR10: 27 } });

        const stats = await writer.processDiff([makeDiff()]);

        expect(stats.failed).toBe(1);
        expect(stats.processed).toBe(0);
        expect(stats.errors[0]).toMatch(/Shoptet 500/);
    });

    describe('KV customer cache side-effect', () => {
        it('extracts the tier percentage from the tier name (ZR10 -> 10) and writes it to the cache under the real email', async () => {
            const client = fakeApiClient();
            const cache: ICustomerCache = { setCustomerDiscount: vi.fn(async () => {}), commit: vi.fn(async () => {}) };
            const writer = new CustomerWriter(client, { pricelistNameMap: { ZR10: 27 }, customerCache: cache });

            await writer.processDiff([makeDiff({ newTier: 'ZR10' })]);

            expect(cache.setCustomerDiscount).toHaveBeenCalledWith('zakaznik@example.test', 10);
        });

        it('does not call setCustomerDiscount (and does not fail the write) when the customer has no email on file', async () => {
            const client = fakeApiClient({ getCustomerDetail: vi.fn(async () => ({ accounts: [] })) });
            const cache: ICustomerCache = { setCustomerDiscount: vi.fn(async () => {}), commit: vi.fn(async () => {}) };
            const writer = new CustomerWriter(client, { pricelistNameMap: { ZR10: 27 }, customerCache: cache });

            const stats = await writer.processDiff([makeDiff()]);

            expect(cache.setCustomerDiscount).not.toHaveBeenCalled();
            // Shoptet zápis samotný uspěl -- chybějící e-mail pro KV cache nesmí zpětně
            // shodit stats.processed, je to jen vedlejší, ne primární efekt zápisu.
            expect(stats.processed).toBe(1);
            expect(stats.failed).toBe(0);
        });

        it('a cache write failure is logged but does not affect the write stats (KV cache is a side-effect, not the primary write)', async () => {
            const client = fakeApiClient();
            const cache: ICustomerCache = {
                setCustomerDiscount: vi.fn(async () => {
                    throw new Error('KV unavailable');
                }),
                commit: vi.fn(async () => {}),
            };
            const writer = new CustomerWriter(client, { pricelistNameMap: { ZR10: 27 }, customerCache: cache });

            const stats = await writer.processDiff([makeDiff()]);

            expect(stats.processed).toBe(1);
            expect(stats.failed).toBe(0);
        });
    });
});
