import { Env, runFeedGeneration } from './feed-generator';
import { calculateAllTierPrices, CsvRow } from './engine/pricing';
import { DASHBOARD_HTML } from './dashboard-html';

const SECRET_TOKEN = 'shoptet-vip-secret-12345';

function jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            // The discount lookup is called directly from the customer's browser
            // (frontend JS on the storefront domain), a different origin than this
            // Worker — without this header the browser blocks the response entirely.
            'Access-Control-Allow-Origin': '*'
        }
    });
}

function checkAuth(request: Request): boolean {
    const auth = request.headers.get('Authorization') ?? '';
    return auth === `Bearer ${SECRET_TOKEN}`;
}

// Shoptet signs webhook bodies as hash_hmac('sha1', body, signingKey), sent in the
// Shoptet-Webhook-Signature header. Recompute with Web Crypto and compare.
async function verifyShoptetSignature(body: string, signatureHex: string, key: string): Promise<boolean> {
    if (!signatureHex) return false;
    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
        'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
    );
    const sigBuffer = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(body));
    const computedHex = Array.from(new Uint8Array(sigBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    if (computedHex.length !== signatureHex.length) return false;
    let diff = 0;
    for (let i = 0; i < computedHex.length; i++) diff |= computedHex.charCodeAt(i) ^ signatureHex.charCodeAt(i);
    return diff === 0;
}

async function triggerGithubSync(token: string, event?: string, eventInstance?: string): Promise<void> {
    try {
        const res = await fetch('https://api.github.com/repos/hlancaric-ship-it/okfish-pricing-engine/dispatches', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'okfish-pricing-engine-worker',
            },
            body: JSON.stringify({ event_type: 'shoptet-webhook', client_payload: { event, eventInstance } }),
        });
        if (!res.ok) console.error('[webhook] GitHub dispatch failed', res.status, await res.text());
    } catch (e) {
        console.error('[webhook] GitHub dispatch error', e);
    }
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        const path = url.pathname;

        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
                }
            });
        }

        // === GET /dashboard ===
        // Serves the live sync-monitor page same-origin (avoids the strict CSP that
        // blocks external fetch() from claude.ai Artifacts entirely).
        if (path === '/dashboard' && request.method === 'GET') {
            return new Response(DASHBOARD_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }

        // === GET /v1/feed/status ===
        if (path === '/v1/feed/status' && request.method === 'GET') {
            const statusData = await env.VIP_KV.get('feed_generation_status');
            if (!statusData) {
                return jsonResponse({ status: 'idle', message: 'No generation has been run yet.' });
            }
            return jsonResponse(JSON.parse(statusData));
        }

        // === GET /v1/feed/report ===
        if (path === '/v1/feed/report' && request.method === 'GET') {
            const statusData = await env.VIP_KV.get('feed_generation_status');
            if (!statusData) return jsonResponse({ error: 'No report available.' }, 404);
            const parsed = JSON.parse(statusData);
            if (parsed.status !== 'success') {
                return jsonResponse({ error: 'Not succeeded yet.', current: parsed }, 400);
            }
            return jsonResponse(parsed);
        }

        // === POST /v1/feed/generate ===
        // NOTE: This endpoint AWAITS the full generation and returns only after completion.
        // The HTTP connection stays open. This is intentional — it allows monitoring via curl.
        // Scheduled cron also uses the same path.
        if (path === '/v1/feed/generate' && request.method === 'POST') {
            if (!checkAuth(request)) return jsonResponse({ error: 'Unauthorized' }, 401);

            const statusData = await env.VIP_KV.get('feed_generation_status');
            if (statusData) {
                const parsed = JSON.parse(statusData);
                if (parsed.status === 'running') {
                    return jsonResponse({ error: 'Already running.', startedAt: parsed.startedAt }, 429);
                }
            }

            const now = new Date();
            const dateStr = now.toISOString().replace(/[:.]/g, '').replace('T', '_').substring(0, 15);
            const version = `products_${dateStr}.xml`;
            const filename = `vip-feeds/${version}`;

            try {
                // Await directly — HTTP connection stays open during generation
                await runFeedGeneration(env, filename, version);
                const finalStatus = await env.VIP_KV.get('feed_generation_status');
                return jsonResponse(finalStatus ? JSON.parse(finalStatus) : { status: 'success' });
            } catch (e: any) {
                return jsonResponse({ error: e?.message ?? String(e) }, 500);
            }
        }

        // === POST /v1/sync-stats ===
        // Written every 15s by scripts/run-real-sync.ts during a live sync run, so a
        // dashboard (Artifact) can poll live API load/stability without needing to
        // watch GitHub Actions logs. Body: free-form JSON snapshot (request counts,
        // HTTP status breakdown, retries, elapsed time).
        if (path === '/v1/sync-stats' && request.method === 'POST') {
            if (!checkAuth(request)) return jsonResponse({ error: 'Unauthorized' }, 401);
            const body = await request.json().catch(() => null);
            if (!body) return jsonResponse({ error: 'Invalid JSON body' }, 400);
            await env.VIP_KV.put('sync_stats', JSON.stringify({ ...body, updatedAt: new Date().toISOString() }), { expirationTtl: 3600 });
            return jsonResponse({ ok: true });
        }

        // === GET /v1/sync-stats ===
        // Public read (no auth) so the dashboard page can poll it directly from the
        // browser (CORS already open via jsonResponse's Access-Control-Allow-Origin).
        if (path === '/v1/sync-stats' && request.method === 'GET') {
            const data = await env.VIP_KV.get('sync_stats');
            if (!data) return jsonResponse({ status: 'idle', message: 'No sync has run recently.' });
            return jsonResponse(JSON.parse(data));
        }

        // === POST /v1/import/begin ===
        // Starts a new customer-discount import version. Blue/Green: nothing live is
        // touched until /finish flips 'active_customer_version'.
        if (path === '/v1/import/begin' && request.method === 'POST') {
            if (!checkAuth(request)) return jsonResponse({ error: 'Unauthorized' }, 401);
            const version = `v${Date.now()}`;
            return jsonResponse({ version });
        }

        // === POST /v1/import/chunk ===
        // Body: { version, customers: [{ hash, discount }] }. Each customer is stored
        // under a version-scoped key so an in-progress import never affects live reads.
        if (path === '/v1/import/chunk' && request.method === 'POST') {
            if (!checkAuth(request)) return jsonResponse({ error: 'Unauthorized' }, 401);
            const body = await request.json() as { version: string; customers: Array<{ hash: string; discount: number }> };
            if (!body?.version || !Array.isArray(body.customers)) {
                return jsonResponse({ error: 'Invalid payload' }, 400);
            }
            await Promise.all(body.customers.map(c =>
                env.VIP_KV.put(`customer:${body.version}:${c.hash}`, String(c.discount))
            ));
            return jsonResponse({ ok: true, count: body.customers.length });
        }

        // === GET /v1/import/active ===
        if (path === '/v1/import/active' && request.method === 'GET') {
            if (!checkAuth(request)) return jsonResponse({ error: 'Unauthorized' }, 401);
            const version = await env.VIP_KV.get('active_customer_version');
            return jsonResponse({ version });
        }

        // === POST /v1/import/finish ===
        // Flips 'active_customer_version' to the new version — the atomic cutover.
        // Returns the previous active version so the caller can clean it up.
        if (path === '/v1/import/finish' && request.method === 'POST') {
            if (!checkAuth(request)) return jsonResponse({ error: 'Unauthorized' }, 401);
            const body = await request.json() as { version: string; customers: number };
            if (!body?.version) return jsonResponse({ error: 'Invalid payload' }, 400);
            const oldVersion = await env.VIP_KV.get('active_customer_version');
            await env.VIP_KV.put('active_customer_version', body.version);
            return jsonResponse({ ok: true, version: body.version, oldVersion });
        }

        // === POST /v1/import/cleanup ===
        // Deletes all customer:<version>:* keys for a retired (no longer active) version.
        if (path === '/v1/import/cleanup' && request.method === 'POST') {
            if (!checkAuth(request)) return jsonResponse({ error: 'Unauthorized' }, 401);
            const body = await request.json() as { version: string };
            if (!body?.version) return jsonResponse({ error: 'Invalid payload' }, 400);
            let cursor: string | undefined;
            let deleted = 0;
            do {
                const list = await env.VIP_KV.list({ prefix: `customer:${body.version}:`, cursor });
                await Promise.all(list.keys.map(k => env.VIP_KV.delete(k.name)));
                deleted += list.keys.length;
                cursor = list.list_complete ? undefined : (list as any).cursor;
            } while (cursor);
            return jsonResponse({ ok: true, deleted });
        }

        // === GET /v1/discount/:hash ===
        // Public (no auth — called directly from the customer's browser). Looks up the
        // SHA-256 hash of the logged-in customer's email against the currently ACTIVE
        // import version only, so an in-progress /chunk upload never leaks partial data.
        if (path.startsWith('/v1/discount/') && request.method === 'GET') {
            const hash = path.substring('/v1/discount/'.length);
            const activeVersion = await env.VIP_KV.get('active_customer_version');
            if (!activeVersion) return jsonResponse({ error: 'No active customer data' }, 404);
            const discountStr = await env.VIP_KV.get(`customer:${activeVersion}:${hash}`);
            if (discountStr === null) return jsonResponse({ error: 'Not found' }, 404);
            return jsonResponse({ v: 1, discount: Number(discountStr) });
        }

        // === POST /v1/webhook/shoptet ===
        // Shoptet calls this within seconds of order:create/order:update (registered
        // via POST /api/webhooks). We verify the HMAC-SHA1 signature so only Shoptet
        // can trigger this, then fire a GitHub repository_dispatch so sync.yml's
        // incremental sync runs immediately instead of waiting up to 15min for cron.
        // Must ack within Shoptet's 4s timeout -- ctx.waitUntil lets the GitHub call
        // finish after the response is already sent. Cron stays as the fallback safety
        // net if this ever misfires or Shoptet's 3 webhook retries are exhausted.
        if (path === '/v1/webhook/shoptet' && request.method === 'POST') {
            const bodyText = await request.text();
            const signature = request.headers.get('Shoptet-Webhook-Signature') ?? '';
            const signingKey = env.SHOPTET_WEBHOOK_SIGNING_KEY;
            if (!signingKey) {
                console.error('[webhook] SHOPTET_WEBHOOK_SIGNING_KEY not configured');
                return jsonResponse({ error: 'Webhook not configured' }, 503);
            }
            const valid = await verifyShoptetSignature(bodyText, signature, signingKey);
            if (!valid) return jsonResponse({ error: 'Invalid signature' }, 401);

            let payload: Record<string, any> = {};
            try { payload = JSON.parse(bodyText); } catch { /* ignore malformed body */ }

            // For product:create/product:update (registered with sendPayload:"full")
            // eventInstance may be Shoptet's internal numeric ID, not the merchant
            // `code` our pricing engine keys on (same code/internal-ID split we hit
            // with data-micro-product-id in vip_catalog.js). We don't have a
            // confirmed real payload shape for this yet, so try the plausible
            // locations rather than assume one -- sync-coupon-fields-single-product.ts
            // already safely no-ops if the code it's given isn't found in the feed,
            // so a wrong guess here just logs and skips, it can't write bad data.
            const productCode = payload.data?.code ?? payload.product?.code ?? payload.data?.product?.code ?? payload.code;
            if (payload.event?.startsWith('product:') && !productCode) {
                console.warn('[webhook] product event but could not find a `code` field in payload -- logging shape for debugging:', bodyText.slice(0, 500));
            }

            if (env.GITHUB_DISPATCH_TOKEN) {
                ctx.waitUntil(triggerGithubSync(env.GITHUB_DISPATCH_TOKEN, payload.event, productCode ?? payload.eventInstance));
            } else {
                console.error('[webhook] GITHUB_DISPATCH_TOKEN not configured -- signature verified but no sync triggered');
            }
            return jsonResponse({ ok: true });
        }

        // === POST /v1/products/import/begin ===
        if (path === '/v1/products/import/begin' && request.method === 'POST') {
            if (!checkAuth(request)) return jsonResponse({ error: 'Unauthorized' }, 401);
            const version = `v${Date.now()}`;
            return jsonResponse({ version });
        }

        // === POST /v1/products/import/chunk ===
        // Body: { version, products: [{ code, row }] } where `row` is the minimal set of
        // CsvRow fields calculateAllTierPrices() needs (price, actionPrice, standardPrice,
        // maxDiscount, percentVat, applyLoyaltyDiscount, manufacturer, categoryText) — the
        // SAME engine already used for the xlsx pricelist recalculation, so the cart badge
        // and the pricelist price can never disagree.
        if (path === '/v1/products/import/chunk' && request.method === 'POST') {
            if (!checkAuth(request)) return jsonResponse({ error: 'Unauthorized' }, 401);
            const body = await request.json() as { version: string; products: Array<{ code: string; row: CsvRow }> };
            if (!body?.version || !Array.isArray(body.products)) {
                return jsonResponse({ error: 'Invalid payload' }, 400);
            }
            await Promise.all(body.products.map(p =>
                env.VIP_KV.put(`product:${body.version}:${p.code}`, JSON.stringify(p.row))
            ));
            return jsonResponse({ ok: true, count: body.products.length });
        }

        // === POST /v1/products/import/finish ===
        if (path === '/v1/products/import/finish' && request.method === 'POST') {
            if (!checkAuth(request)) return jsonResponse({ error: 'Unauthorized' }, 401);
            const body = await request.json() as { version: string };
            if (!body?.version) return jsonResponse({ error: 'Invalid payload' }, 400);
            const oldVersion = await env.VIP_KV.get('active_product_version');
            await env.VIP_KV.put('active_product_version', body.version);
            return jsonResponse({ ok: true, version: body.version, oldVersion });
        }

        // === GET /v1/product-discount/:code/:tier ===
        // Public. Returns the REAL, product-specific discount for one tier (e.g. ZR4),
        // computed by the same engine that writes the live pricelist — so unlike the old
        // flat customer-tier %, this correctly reflects maxDiscount caps, action prices,
        // and loyalty-disabled products (e.g. gift cards).
        if (path.startsWith('/v1/product-discount/') && request.method === 'GET') {
            const parts = path.substring('/v1/product-discount/'.length).split('/');
            const code = parts[0];
            const tier = parts[1];
            if (!code || !tier) return jsonResponse({ error: 'Usage: /v1/product-discount/:code/:tier' }, 400);

            const activeVersion = await env.VIP_KV.get('active_product_version');
            if (!activeVersion) return jsonResponse({ error: 'No active product data' }, 404);
            const rowJson = await env.VIP_KV.get(`product:${activeVersion}:${code}`);
            if (rowJson === null) return jsonResponse({ error: 'Product not found' }, 404);

            const row = JSON.parse(rowJson) as CsvRow;
            const tierPrices = calculateAllTierPrices(row);
            const tierResult = tierPrices[tier];
            if (!tierResult) return jsonResponse({ error: 'Unknown tier' }, 400);

            const standardPrice = parseFloat((row['standardPrice'] || row['price'] || '0').replace(',', '.'));
            const finalPrice = tierResult.price;
            const discountPct = standardPrice > finalPrice
                ? Math.round((1 - finalPrice / standardPrice) * 100)
                : 0;

            return jsonResponse({ v: 1, code, tier, price: finalPrice, standardPrice, discountPct });
        }

        // === GET /feed.xml ===
        if (path === '/feed.xml' && request.method === 'GET') {
            const activeFeedData = await env.VIP_KV.get('active_feed');
            if (!activeFeedData) return new Response('No active feed.', { status: 404 });
            const activeFeed = JSON.parse(activeFeedData);
            const object = await env.FEED_BUCKET.get(activeFeed.filename);
            if (!object) return new Response('Feed file not found in R2.', { status: 404 });
            return new Response(object.body, {
                headers: {
                    'Content-Type': 'application/xml; charset=utf-8',
                    'Cache-Control': 'public, max-age=3600',
                    'X-Feed-Version': activeFeed.version ?? 'unknown'
                }
            });
        }

        return jsonResponse({ error: 'Not found.' }, 404);
    },

    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
        const now = new Date();
        const dateStr = now.toISOString().replace(/[:.]/g, '').replace('T', '_').substring(0, 15);
        const version = `products_${dateStr}.xml`;
        const filename = `vip-feeds/${version}`;
        // Scheduled events have longer CPU budget — use waitUntil here
        ctx.waitUntil(runFeedGeneration(env, filename, version).catch(e => {
            console.error('Scheduled gen failed:', e);
        }));
    }
};
