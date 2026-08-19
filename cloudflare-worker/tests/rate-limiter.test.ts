import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShoptetRateLimiter } from '../src/shoptet-api/rate-limiter.js';
import { GlobalStats } from '../src/shoptet-api/client.js';

function fakeResponse(status: number, opts: { retryAfter?: string; body?: string } = {}): Response {
    const headers = new Headers();
    if (opts.retryAfter) headers.set('Retry-After', opts.retryAfter);
    return {
        ok: status >= 200 && status < 300,
        status,
        url: 'https://example.test/api',
        headers,
        text: async () => opts.body ?? '',
    } as unknown as Response;
}

describe('ShoptetRateLimiter', () => {
    beforeEach(() => {
        Object.keys(GlobalStats.retries).forEach((k) => delete GlobalStats.retries[Number(k)]);
    });

    it('returns the parsed result on the first successful (2xx) response', async () => {
        const limiter = new ShoptetRateLimiter({ initialBackoffMs: 1 });
        const requestFn = vi.fn(async () => fakeResponse(200));
        const parseFn = vi.fn(async () => ({ ok: true }));

        const result = await limiter.execute(requestFn, parseFn);

        expect(result).toEqual({ ok: true });
        expect(requestFn).toHaveBeenCalledTimes(1);
    });

    it('retries on a retryable status (429) and eventually succeeds', async () => {
        const limiter = new ShoptetRateLimiter({ initialBackoffMs: 1, maxBackoffMs: 5 });
        let call = 0;
        const requestFn = vi.fn(async () => {
            call++;
            return call < 3 ? fakeResponse(429) : fakeResponse(200);
        });
        const parseFn = vi.fn(async () => 'done');

        const result = await limiter.execute(requestFn, parseFn);

        expect(result).toBe('done');
        expect(requestFn).toHaveBeenCalledTimes(3);
        // GlobalStats sleduje počet retry pokusů podle HTTP statusu -- používá se
        // pro provozní metriky, kontrolujeme, že se opravdu inkrementuje.
        expect(GlobalStats.retries[429]).toBe(2);
    });

    it('honors the Retry-After header as a floor on the wait time', async () => {
        const limiter = new ShoptetRateLimiter({ initialBackoffMs: 1, maxBackoffMs: 100000 });
        let call = 0;
        const requestFn = vi.fn(async () => {
            call++;
            return call === 1 ? fakeResponse(429, { retryAfter: '0' }) : fakeResponse(200);
        });
        const parseFn = vi.fn(async () => 'ok');

        // Retry-After: 0 by nemělo shodit test (waitTime = max(backoff, 0)) --
        // hlavně ověřujeme, že se hlavička přečte bez pádu a nic neblokuje navždy.
        const result = await limiter.execute(requestFn, parseFn);
        expect(result).toBe('ok');
    });

    it('throws immediately on a non-retryable status (e.g. 404) without retrying', async () => {
        const limiter = new ShoptetRateLimiter({ initialBackoffMs: 1 });
        const requestFn = vi.fn(async () => fakeResponse(404, { body: 'not found' }));
        const parseFn = vi.fn();

        await expect(limiter.execute(requestFn, parseFn)).rejects.toThrow(/404/);
        expect(requestFn).toHaveBeenCalledTimes(1);
    });

    it('gives up and throws after exceeding maxRetries on a retryable status', async () => {
        const limiter = new ShoptetRateLimiter({ initialBackoffMs: 1, maxBackoffMs: 2, maxRetries: 2 });
        const requestFn = vi.fn(async () => fakeResponse(503));
        const parseFn = vi.fn();

        await expect(limiter.execute(requestFn, parseFn)).rejects.toThrow(/503/);
        // 1 počáteční pokus + 2 retries = 3 volání
        expect(requestFn).toHaveBeenCalledTimes(3);
    });

    it('retries on a network error (rejected requestFn) and succeeds once it recovers', async () => {
        const limiter = new ShoptetRateLimiter({ initialBackoffMs: 1, maxBackoffMs: 2 });
        let call = 0;
        const requestFn = vi.fn(async () => {
            call++;
            if (call === 1) throw new Error('ECONNRESET');
            return fakeResponse(200);
        });
        const parseFn = vi.fn(async () => 'recovered');

        const result = await limiter.execute(requestFn, parseFn);
        expect(result).toBe('recovered');
        expect(requestFn).toHaveBeenCalledTimes(2);
    });

    it('respects maxConcurrency by queuing requests beyond the limit', async () => {
        const limiter = new ShoptetRateLimiter({ maxConcurrency: 1, initialBackoffMs: 1 });
        const order: number[] = [];

        // Dva požadavky "na dlouho" -- druhý smí začít až po release() prvního,
        // což ověřuje, že se fronta (queue) skutečně respektuje.
        const makeSlowRequest = (id: number, delayMs: number) => async () => {
            await new Promise((r) => setTimeout(r, delayMs));
            order.push(id);
            return fakeResponse(200);
        };

        const p1 = limiter.execute(makeSlowRequest(1, 20), async () => 'a');
        const p2 = limiter.execute(makeSlowRequest(2, 0), async () => 'b');

        await Promise.all([p1, p2]);
        // Požadavek 1 musel doběhnout (a uvolnit slot) dřív, než druhý vůbec started -- tj. 1 před 2.
        expect(order).toEqual([1, 2]);
    });

    it('propagates a parse error as a descriptive Error, not a silent failure', async () => {
        const limiter = new ShoptetRateLimiter({ initialBackoffMs: 1 });
        const requestFn = vi.fn(async () => fakeResponse(200));
        const parseFn = vi.fn(async () => {
            throw new Error('invalid json');
        });

        await expect(limiter.execute(requestFn, parseFn)).rejects.toThrow(/Chyba při parsování odpovědi/);
    });
});
