import { describe, it, expect } from 'vitest';
import worker from '../src/index.js';
import { Env } from '../src/feed-generator.js';

// Onboarding a new client used to require manually FTP-ing vip_*.js onto their own
// hosting -- this route serves those files directly from the Worker instead, so a
// client only ever needs to paste one <script src="https://<worker>/static/vip_prices.js">
// tag into their store's header snippet. Content is baked in at build time via
// scripts/generate-static-assets.ts (npm run build:static-assets) -- see
// cloudflare-worker/src/static-assets.ts (generated, not hand-edited).
function fakeEnv(): Env {
    return {} as Env;
}
function fakeCtx(): ExecutionContext {
    return { waitUntil: () => {}, passThroughOnException: () => {} } as any;
}

describe('GET /static/:filename', () => {
    it('serves vip_prices.js with the right content-type and long cache headers', async () => {
        const req = new Request('https://worker.example.test/static/vip_prices.js');
        const res = await worker.fetch(req, fakeEnv(), fakeCtx());

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('application/javascript; charset=utf-8');
        expect(res.headers.get('Cache-Control')).toContain('max-age=3600');
        const body = await res.text();
        expect(body.length).toBeGreaterThan(0);
        // Sanity: the served content is genuinely the frontend loader script, not a
        // stale/empty placeholder.
        expect(body).toContain('updateDiscountBadges');
    });

    it('serves all six known frontend files', async () => {
        const files = [
            'vip_prices.js', 'vip_detail.js', 'vip_cart.js',
            'vip_catalog.js', 'vip_cart_coupon_lock.js', 'vip_registration_hide_types.js',
        ];
        for (const file of files) {
            const req = new Request(`https://worker.example.test/static/${file}`);
            const res = await worker.fetch(req, fakeEnv(), fakeCtx());
            expect(res.status, file).toBe(200);
            expect((await res.text()).length, file).toBeGreaterThan(0);
        }
    });

    it('returns 404 for an unknown filename (not an arbitrary file-read gadget)', async () => {
        const req = new Request('https://worker.example.test/static/../../etc/passwd');
        const res = await worker.fetch(req, fakeEnv(), fakeCtx());
        expect(res.status).toBe(404);
    });

    it('is CORS-open (Access-Control-Allow-Origin: *), same as the other public read endpoints', async () => {
        const req = new Request('https://worker.example.test/static/vip_prices.js');
        const res = await worker.fetch(req, fakeEnv(), fakeCtx());
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
});
