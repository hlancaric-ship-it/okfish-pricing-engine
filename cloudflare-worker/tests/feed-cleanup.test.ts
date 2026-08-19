import { describe, it, expect, vi } from 'vitest';
import { cleanupOldFeeds } from '../src/feed-generator.js';

// Regression test: runFeedGeneration() uploads a new, uniquely-timestamped R2 object
// on every run (~5x/day via cron) and used to never delete old ones -- unbounded R2
// storage growth forever, same shape of bug as INC-007's KV growth issue. This tests
// the cleanup function in isolation with a minimal fake R2Bucket (list + delete only,
// the only two methods cleanupOldFeeds actually calls).
function fakeBucket(keys: string[]) {
    return {
        list: vi.fn(async ({ prefix }: { prefix: string }) => ({
            objects: keys.filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
        })),
        delete: vi.fn(async (_keysToDelete: string[]) => {}),
    } as any;
}

describe('cleanupOldFeeds', () => {
    it('deletes nothing when the bucket has fewer objects than the retention window', async () => {
        const keys = ['vip-feeds/products_20260819_060000.xml', 'vip-feeds/products_20260819_100000.xml'];
        const bucket = fakeBucket(keys);
        const env = { FEED_BUCKET: bucket } as any;

        const result = await cleanupOldFeeds(env, keys[1]);

        expect(bucket.delete).not.toHaveBeenCalled();
        expect(result.deleted).toEqual([]);
        expect(result.kept).toBe(2);
    });

    it('keeps only the most recent 10 objects plus the active one, deletes the rest', async () => {
        // 15 old feeds (chronologically sortable by filename) + today's freshly
        // generated (and now active) one, 16 total.
        const oldKeys = Array.from({ length: 15 }, (_, i) =>
            `vip-feeds/products_202608${String(i + 1).padStart(2, '0')}_060000.xml`
        );
        const activeKey = 'vip-feeds/products_20260819_220000.xml';
        const bucket = fakeBucket([...oldKeys, activeKey]);
        const env = { FEED_BUCKET: bucket } as any;

        const result = await cleanupOldFeeds(env, activeKey);

        expect(bucket.delete).toHaveBeenCalledTimes(1);
        const deletedArg = bucket.delete.mock.calls[0][0] as string[];
        // 16 total - 10 kept-by-recency = 6 deleted (the 6 oldest, since active is
        // already inside the most-recent-10 window here).
        expect(deletedArg).toHaveLength(6);
        expect(deletedArg).toEqual(oldKeys.slice(0, 6));
        expect(result.kept).toBe(10);
    });

    it('never deletes the active feed even if it is older than the retention window', async () => {
        // Active feed is the OLDEST object -- e.g. a scheduled generation failed
        // several times in a row and this stale feed is still the one being served.
        const activeKey = 'vip-feeds/products_20260101_000000.xml';
        const recentKeys = Array.from({ length: 12 }, (_, i) =>
            `vip-feeds/products_202608${String(i + 1).padStart(2, '0')}_060000.xml`
        );
        const bucket = fakeBucket([activeKey, ...recentKeys]);
        const env = { FEED_BUCKET: bucket } as any;

        const result = await cleanupOldFeeds(env, activeKey);

        const deletedArg = bucket.delete.mock.calls[0][0] as string[];
        expect(deletedArg).not.toContain(activeKey);
        // 13 total, keep 10 most recent + always keep active (outside that window) = 11 kept, 2 deleted.
        expect(deletedArg).toHaveLength(2);
        expect(result.kept).toBe(11);
    });

    it('only lists/deletes objects under the vip-feeds/ prefix, not the whole bucket', async () => {
        const bucket = fakeBucket(['vip-feeds/products_20260819_060000.xml', 'other-prefix/unrelated.json']);
        const env = { FEED_BUCKET: bucket } as any;

        await cleanupOldFeeds(env, 'vip-feeds/products_20260819_060000.xml');

        expect(bucket.list).toHaveBeenCalledWith({ prefix: 'vip-feeds/' });
    });
});
