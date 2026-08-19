import { Env, runFeedGeneration } from './feed-generator';
import { calculateAllTierPrices, CsvRow } from './engine/pricing';
import { DASHBOARD_HTML } from './dashboard-html';
import { ORDERS_DASHBOARD_HTML } from './orders-dashboard-html';
import {
    VIP_PRICES_JS, VIP_DETAIL_JS, VIP_CART_JS, VIP_CATALOG_JS,
    VIP_CART_COUPON_LOCK_JS, VIP_REGISTRATION_HIDE_TYPES_JS
} from './static-assets';

// Serves the frontend JS files directly from the Worker instead of requiring the
// client to FTP them onto their own hosting -- onboarding a new client (or updating
// an existing one) becomes "paste one <script src="https://<worker>/static/vip_prices.js">
// tag into Shoptet's header snippet", no FTP account, no manual file upload, ever.
// Content is baked in at deploy time (see scripts/generate-static-assets.ts,
// npm run build:static-assets, wired as this package's `predeploy` hook) -- editing a
// vip_*.js file and deploying without regenerating first would silently serve stale
// content, so the predeploy hook is what actually keeps this safe, not this route.
const STATIC_JS_FILES: Record<string, string> = {
    'vip_prices.js': VIP_PRICES_JS,
    'vip_detail.js': VIP_DETAIL_JS,
    'vip_cart.js': VIP_CART_JS,
    'vip_catalog.js': VIP_CATALOG_JS,
    'vip_cart_coupon_lock.js': VIP_CART_COUPON_LOCK_JS,
    'vip_registration_hide_types.js': VIP_REGISTRATION_HIDE_TYPES_JS,
};

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

        // === GET /static/:filename ===
        // Serves vip_prices.js / vip_detail.js / vip_cart.js / vip_catalog.js /
        // vip_cart_coupon_lock.js / vip_registration_hide_types.js -- see
        // STATIC_JS_FILES above for why this exists (no-FTP onboarding).
        if (path.startsWith('/static/') && request.method === 'GET') {
            const filename = path.substring('/static/'.length);
            const content = STATIC_JS_FILES[filename];
            if (content === undefined) return new Response('Not found.', { status: 404 });
            return new Response(content, {
                headers: {
                    'Content-Type': 'application/javascript; charset=utf-8',
                    // 1h client cache + 24h stale-while-revalidate: this content only
                    // changes on a deploy (baked in at build time, not per-request), so
                    // aggressive caching is safe -- a deploy naturally busts CDN edge
                    // caches too (new Worker version = new response for the same URL
                    // isn't guaranteed instant globally, but 1h is a reasonable trade-off
                    // for a script that isn't expected to change more than a few times a
                    // year per client).
                    'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
                    'Access-Control-Allow-Origin': '*'
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

        // === POST /v1/orders-status ===
        // Nová, ÚPLNĚ IZOLOVANÁ funkce (2026-08-06): skladový semafor +
        // stav platby otevřených objednávek. Zapisuje compute-orders-stock-status.ts
        // (samostatný krok v sync.yml, continue-on-error), čte skrytá stránka
        // /orders-dashboard-xk92q. Nesahá na žádnou existující KV klíč ani logiku.
        if (path === '/v1/orders-status' && request.method === 'POST') {
            if (!checkAuth(request)) return jsonResponse({ error: 'Unauthorized' }, 401);
            const body = await request.json().catch(() => null);
            if (!body) return jsonResponse({ error: 'Invalid JSON body' }, 400);
            // TTL byl původně 3600s (1h) -- příliš křehké: jediný vynechaný
            // sync.yml běh (deploy, git push race, dočasná chyba) nechal KV
            // klíč vypršet a dashboard spadl na "0 objednávek" i když byla
            // živá data k dispozici (potvrzeno živě 2026-08-06). 86400s (24h)
            // dává rozumnou rezervu -- i celý den výpadku automatiky dashboard
            // neztratí data, jen přestane být čerstvý (a to je vidět v
            // "aktualizováno" časovém razítku, ne jako prázdný seznam).
            await env.VIP_KV.put('orders_status', JSON.stringify(body), { expirationTtl: 86400 });
            return jsonResponse({ ok: true });
        }

        // === GET /v1/orders-status ===
        // Sloučí čerstvě přepočítaná data (orders_status, přepisuje se každým
        // sync.yml během) s ručně označenými "vyriešené" objednávkami
        // (resolved_orders, samostatný KV klíč -- NIKDY nepřepsán přepočtem,
        // takže ruční označení přežije i příští automatický refresh).
        if (path === '/v1/orders-status' && request.method === 'GET') {
            if (!checkAuth(request)) return jsonResponse({ error: 'Unauthorized' }, 401);
            const data = await env.VIP_KV.get('orders_status');
            const resolvedRaw = await env.VIP_KV.get('resolved_orders');
            const resolved: Record<string, string> = resolvedRaw ? JSON.parse(resolvedRaw) : {};
            if (!data) return jsonResponse({ orders: [], updatedAt: null });
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed.orders)) {
                parsed.orders = parsed.orders.map((o: any) => ({
                    ...o,
                    // Vyriešené buď automaticky (reálny stav v Shoptete -- Vybavená/
                    // Stornovaná), alebo ručne cez tlačidlo. Automatika má prednosť
                    // vo význame, ale obe cesty vedú na rovnaký badge/prečiarknutie.
                    resolved: !!resolved[o.code] || !!o.resolvedByStatus,
                    resolvedAt: resolved[o.code] || null,
                }));
            }
            return jsonResponse(parsed);
        }

        // === POST /v1/order-resolved ===
        // Body: { code, resolved: true|false }. Ukládá se odděleně od
        // orders_status, aby to nepřepsal příští automatický přepočet.
        if (path === '/v1/order-resolved' && request.method === 'POST') {
            const token = url.searchParams.get('token');
            if (token !== SECRET_TOKEN) return jsonResponse({ error: 'Unauthorized' }, 401);
            const body = await request.json().catch(() => null) as { code?: string; resolved?: boolean } | null;
            if (!body?.code) return jsonResponse({ error: 'Usage: { code, resolved }' }, 400);
            const resolvedRaw = await env.VIP_KV.get('resolved_orders');
            const resolved: Record<string, string> = resolvedRaw ? JSON.parse(resolvedRaw) : {};
            if (body.resolved) {
                resolved[body.code] = new Date().toISOString();
            } else {
                delete resolved[body.code];
            }
            await env.VIP_KV.put('resolved_orders', JSON.stringify(resolved));
            return jsonResponse({ ok: true });
        }

        // === GET /orders-dashboard-xk92q ===
        // Schválně neobvyklá cesta, nikde neodkazovaná -- skrytá stránka, ne
        // veřejná funkce webu. Vyžaduje auth přes ?token= query param (prostá
        // stránka v prohlížeči nemůže poslat Authorization header sama).
        if (path === '/orders-dashboard-xk92q' && request.method === 'GET') {
            const token = url.searchParams.get('token');
            if (token !== SECRET_TOKEN) return new Response('Unauthorized', { status: 401 });
            return new Response(ORDERS_DASHBOARD_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }

        // === GET /objednavky-prehlad ===
        // Čistá adresa bez tokenu v URL -- stránka sama má prihlasovacie okno
        // (heslo se ověří proti /v1/orders-status a uloží se do cookie), takže
        // se odkaz dá poslat klientovi bez viditelného hesla v odkazu.
        if (path === '/objednavky-prehlad' && request.method === 'GET') {
            return new Response(ORDERS_DASHBOARD_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }

        // === POST /v1/order-note ===
        // Zapíše "Poznámka e-shopu" na konkrétní objednávku. Volané ze skryté
        // /orders-dashboard-xk92q stránky. NEOTESTOVÁNO naživo -- formát těla
        // (eshopRemark v data objektu) je odvozený ze stejného vzoru jako zbytek
        // Shoptet API, ale endpoint PATCH /orders/{code}/notes jsme nikdy
        // nezavolali, dokud to výslovně nepotvrdí klient na konkrétní objednávce.
        if (path === '/v1/order-note' && request.method === 'POST') {
            const token = url.searchParams.get('token');
            if (token !== SECRET_TOKEN) return jsonResponse({ error: 'Unauthorized' }, 401);
            if (!env.SHOPTET_PRIVATE_API_TOKEN) return jsonResponse({ error: 'SHOPTET_PRIVATE_API_TOKEN not configured' }, 503);

            const body = await request.json().catch(() => null) as { code?: string; note?: string } | null;
            if (!body?.code || body.note === undefined) return jsonResponse({ error: 'Usage: { code, note }' }, 400);

            const res = await fetch(`https://api.myshoptet.com/api/orders/${encodeURIComponent(body.code)}/notes`, {
                method: 'PATCH',
                headers: {
                    'Shoptet-Private-API-Token': env.SHOPTET_PRIVATE_API_TOKEN,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: JSON.stringify({ data: { eshopRemark: body.note } }),
            });
            const resJson = await res.json().catch(() => null);
            if (!res.ok) return jsonResponse({ error: 'Shoptet API error', status: res.status, detail: resJson }, 502);
            return jsonResponse({ ok: true });
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
            // Diff-aware zápis (2026-08-12): dřív se sem posílal KOMPLETNÍ katalog při
            // KAŽDÉM běhu (cron 15min i webhook) a každý produkt se zapsal pod novým
            // verzovaným klíčem product:${version}:${code} bez ohledu na to, jestli se
            // cokoliv změnilo -- potvrzeno živě: 16 708 KV zápisů za jeden běh, ~1.6M/den,
            // a staré verze se navíc nikdy nemazaly (neomezeně rostoucí KV storage).
            // Teď se zapisuje pod STABILNÍM klíčem (bez verze) a jen když se obsah
            // opravdu liší od toho, co už v KV je -- žádné nové osiřelé klíče, žádné
            // zbytečné zápisy za nezměněná data.
            let written = 0, skipped = 0;
            await Promise.all(body.products.map(async (p) => {
                const key = `product:${p.code}`;
                const newValue = JSON.stringify(p.row);
                const existing = await env.VIP_KV.get(key);
                if (existing === newValue) { skipped++; return; }
                await env.VIP_KV.put(key, newValue);
                written++;
            }));
            return jsonResponse({ ok: true, count: body.products.length, written, skipped });
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

        // === GET /v1/price-cache/:pricelistId ===
        // Perzistentní náhrada za `.price_cache.json` (viz sync-orchestrator.ts) --
        // ten soubor žil jen na disku GitHub Actions runneru a mezi jednotlivými
        // běhy se NIKDY nezachoval (žádný actions/cache krok, žádný commit do
        // repa), takže diff logika v orchestrátoru byla naživo neúčinná -- oldPrice
        // byla vždy null, takže se do Shoptet ceníku posílal PATCH pro úplně
        // všechny produkty při každém běhu, bez ohledu na to, jestli se cena
        // reálně změnila. Jeden KV klíč na ceník (ne na produkt jako u
        // product-discount cache) -- ceníky mají přirozeně malý, stabilní počet
        // (řádově desítky), takže čtení/zápis celé mapy najednou je levnější než
        // řešit diff po jednotlivých produktech přes GET-před-PUT jako u KV
        // produktové cache.
        if (path.startsWith('/v1/price-cache/') && request.method === 'GET') {
            if (!checkAuth(request)) return jsonResponse({ error: 'Unauthorized' }, 401);
            const pricelistId = path.substring('/v1/price-cache/'.length);
            if (!pricelistId) return jsonResponse({ error: 'Chybí pricelistId' }, 400);
            const raw = await env.VIP_KV.get(`pricecache:${pricelistId}`);
            const prices = raw ? JSON.parse(raw) : {};
            return jsonResponse({ pricelistId, prices });
        }

        // === POST /v1/price-cache/:pricelistId ===
        // Body: { updates: { [productCode]: price } } -- read-modify-write jednoho
        // KV klíče. Volající (RemotePriceCache) sem posílá jen produkty, u kterých
        // se cena reálně změnila oproti tomu, co GET výše vrátil.
        if (path.startsWith('/v1/price-cache/') && request.method === 'POST') {
            if (!checkAuth(request)) return jsonResponse({ error: 'Unauthorized' }, 401);
            const pricelistId = path.substring('/v1/price-cache/'.length);
            if (!pricelistId) return jsonResponse({ error: 'Chybí pricelistId' }, 400);
            const body = await request.json() as { updates: Record<string, string> };
            if (!body?.updates || typeof body.updates !== 'object') {
                return jsonResponse({ error: 'Invalid payload' }, 400);
            }
            const key = `pricecache:${pricelistId}`;
            const raw = await env.VIP_KV.get(key);
            const prices = raw ? JSON.parse(raw) : {};
            Object.assign(prices, body.updates);
            await env.VIP_KV.put(key, JSON.stringify(prices));
            return jsonResponse({ ok: true, pricelistId, updated: Object.keys(body.updates).length, total: Object.keys(prices).length });
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

            // Zkusí nejdřív stabilní klíč (bez verze) -- od 2026-08-12 zapisovaný jen
            // při reálné změně dat, viz import/chunk níže. Padá zpátky na starý
            // verzovaný klíč, dokud stabilní klíč pro daný kód ještě neexistuje
            // (např. těsně po deployi, než proběhne první sync-products běh) --
            // nedojde tak k žádnému výpadku dat během přechodu na nové schéma.
            let rowJson = await env.VIP_KV.get(`product:${code}`);
            if (rowJson === null) {
                const activeVersion = await env.VIP_KV.get('active_product_version');
                if (activeVersion) rowJson = await env.VIP_KV.get(`product:${activeVersion}:${code}`);
            }
            if (rowJson === null) return jsonResponse({ error: 'Product not found' }, 404);

            const row = JSON.parse(rowJson) as CsvRow;
            // sync-products.ts deliberately omits 'code' from the stored row (it's
            // already the KV key, no need to duplicate it) -- but resolveActiveLimit()
            // in engine/pricing.ts needs row['code'] to look up PRODUCT_LIMITS.
            // Without this, product-level overrides (e.g. 101821's 10% cap) were
            // silently ignored and the badge fell back to the raw uncapped loyalty
            // price -- confirmed live 2026-08-06 (showed 25% instead of the correct
            // capped ~10%).
            row['code'] = code;
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
