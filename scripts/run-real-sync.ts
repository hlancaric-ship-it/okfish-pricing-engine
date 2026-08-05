import * as dotenv from 'dotenv';
import { SyncOrchestrator } from '../cloudflare-worker/src/shoptet-api/sync-orchestrator.ts';
import { FileCacheProvider } from '../cloudflare-worker/src/shoptet-api/cache-provider.ts';
import { RemoteCustomerCache, FileCustomerCache } from '../cloudflare-worker/src/shoptet-api/customer-cache.ts';
import { GlobalStats } from '../cloudflare-worker/src/shoptet-api/client.ts';
import * as path from 'path';

// Zkusíme načíst .env z kořenové složky
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Živý přehled zatížení API během běhu -- kolik requestů, jaké HTTP statusy
// (429 = rate limit, 5xx = server chyby), kolik retry pokusů. Vypisuje se
// každých 15s, ať je vidět stabilita a kde nás Shoptet případně omezuje.
function startStatsReporter(): NodeJS.Timeout {
    const startedAt = Date.now();
    let lastGet = 0, lastPatch = 0;
    return setInterval(() => {
        const elapsedS = Math.round((Date.now() - startedAt) / 1000);
        const get = GlobalStats.apiRequests.GET || 0;
        const patch = GlobalStats.apiRequests.PATCH || 0;
        const getRate = (get - lastGet) / 15;
        const patchRate = (patch - lastPatch) / 15;
        lastGet = get; lastPatch = patch;
        const statuses = Object.entries(GlobalStats.httpResponses)
            .map(([code, n]) => `${code}:${n}`).join(', ') || '(zatím žádné)';
        const totalResponses = Object.values(GlobalStats.httpResponses).reduce((a, b) => a + b, 0);
        const okResponses = Object.entries(GlobalStats.httpResponses)
            .filter(([code]) => Number(code) >= 200 && Number(code) < 300)
            .reduce((a, [, n]) => a + n, 0);
        const stabilityPct = totalResponses > 0 ? (okResponses / totalResponses * 100).toFixed(1) : '100.0';
        const totalRetries = Object.values(GlobalStats.retries).reduce((a, b) => a + b, 0);
        const retries = Object.entries(GlobalStats.retries)
            .map(([code, n]) => `${code}×${n}`).join(', ') || 'žádné';
        console.log(`[STATS ${elapsedS}s] GET=${get} (${getRate.toFixed(1)}/s) PATCH=${patch} (${patchRate.toFixed(1)}/s) | Stabilita: ${stabilityPct}% OK (${totalRetries} retry celkem) | HTTP: ${statuses} | Retries: ${retries}`);
    }, 15000);
}

async function run() {
    console.log("=== SPOUŠTÍM PRODUKČNÍ SYNCHRONIZACI ===");

    // Token vezmeme buď z proměnné SHOPTET_PRIVATE_API_TOKEN nebo zkuste případně zadat přímo sem
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) {
        console.error("❌ CHYBA: Chybí Shoptet API Token.");
        console.error("Přidejte do .env souboru řádek: SHOPTET_PRIVATE_API_TOKEN=vas_token");
        console.error("Nebo ho exportujte v terminálu: export SHOPTET_PRIVATE_API_TOKEN=vas_token");
        process.exit(1);
    }

    // Inicializujeme cache - používáme souborovou, aby to fungovalo lokálně
    const cacheProvider = new FileCacheProvider(path.resolve(process.cwd(), '.price_cache.json'));

    console.log("=== STARTING FULL / INCREMENTAL SYNC ===");

    let customerCache;
    if (process.env.CF_WORKER_URL && process.env.CF_WORKER_TOKEN) {
        console.log("-> Using RemoteCustomerCache (CF Worker KV API)");
        customerCache = new RemoteCustomerCache(process.env.CF_WORKER_URL, process.env.CF_WORKER_TOKEN);
    } else {
        console.log("-> CF_WORKER_URL/TOKEN not found. Using local FileCustomerCache.");
        customerCache = new FileCustomerCache();
    }

    const orchestrator = new SyncOrchestrator({
        dryRun: false, // DŮLEŽITÉ: false znamená OSTRÝ BĚH (bude zapisovat PATCH requesty!)
        token: token,
        priceCache: cacheProvider,
        customerCache: customerCache,
        maxPages: undefined // Projdeme vše, co je potřeba
    });

    const statsTimer = startStatsReporter();
    try {
        await orchestrator.runFullSync();
        console.log("=== SYNCHRONIZACE DOKONČENA ===");
    } catch (error) {
        // Previously this only logged the error and let the process exit 0 — in the
        // hourly GitHub Actions cron that meant a failed sync still showed as a green
        // checkmark (no failure-log artifact, no notification), so the pipeline could
        // silently stop working for hours/days with nobody noticing. Must propagate
        // the failure so the Actions step (and any future failure alerting) sees it.
        console.error("❌ CHYBA PŘI BĚHU:", error);
        process.exit(1);
    } finally {
        clearInterval(statsTimer);
        console.log(`[STATS FINAL] GET=${GlobalStats.apiRequests.GET || 0} PATCH=${GlobalStats.apiRequests.PATCH || 0} | HTTP: ${JSON.stringify(GlobalStats.httpResponses)} | Retries: ${JSON.stringify(GlobalStats.retries)}`);
    }
}

run().catch((error) => {
    // Safety net for any error thrown before/outside the try/catch above (e.g. a
    // synchronous throw during setup) — same reasoning: must not exit 0 on failure.
    console.error("❌ NEOČEKÁVANÁ CHYBA:", error);
    process.exit(1);
});
