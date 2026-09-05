import * as dotenv from 'dotenv';
import { SyncOrchestrator } from '../cloudflare-worker/src/shoptet-api/sync-orchestrator';
import { RemoteCustomerCache, FileCustomerCache } from '../cloudflare-worker/src/shoptet-api/customer-cache';
import { RemotePriceCache } from '../cloudflare-worker/src/shoptet-api/remote-price-cache';
import { RemoteForceSync } from '../cloudflare-worker/src/shoptet-api/remote-force-sync';
import { GlobalStats } from '../cloudflare-worker/src/shoptet-api/client';
import * as path from 'path';

// Zkusíme načíst .env z kořenové složky
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Živý přehled zatížení API během běhu -- kolik requestů, jaké HTTP statusy
// (429 = rate limit, 5xx = server chyby), kolik retry pokusů. Vypisuje se do
// konzole a zároveň (pokud jsou nastavené CF_WORKER_URL/TOKEN) posílá do
// Workeru (POST /v1/sync-stats), aby to šlo sledovat živě i z dashboardu
// mimo GitHub Actions log. Odesílání je fire-and-forget -- selhání nesmí
// zastavit samotný sync.
function startStatsReporter(): NodeJS.Timeout {
    const startedAt = Date.now();
    let lastGet = 0, lastPatch = 0;
    const workerUrl = process.env.CF_WORKER_URL;
    const workerToken = process.env.CF_WORKER_TOKEN;

    return setInterval(() => {
        const elapsedS = Math.round((Date.now() - startedAt) / 1000);
        const get = GlobalStats.apiRequests.GET || 0;
        const patch = GlobalStats.apiRequests.PATCH || 0;
        const getRate = (get - lastGet) / 15;
        const patchRate = (patch - lastPatch) / 15;
        lastGet = get; lastPatch = patch;
        const totalResponses = Object.values(GlobalStats.httpResponses).reduce((a, b) => a + b, 0);
        const okResponses = Object.entries(GlobalStats.httpResponses)
            .filter(([code]) => Number(code) >= 200 && Number(code) < 300)
            .reduce((a, [, n]) => a + n, 0);
        const stabilityPct = totalResponses > 0 ? (okResponses / totalResponses * 100) : 100;
        const totalRetries = Object.values(GlobalStats.retries).reduce((a, b) => a + b, 0);
        const statuses = Object.entries(GlobalStats.httpResponses).map(([code, n]) => `${code}:${n}`).join(', ') || '(zatím žádné)';
        const retries = Object.entries(GlobalStats.retries).map(([code, n]) => `${code}×${n}`).join(', ') || 'žádné';

        console.log(`[STATS ${elapsedS}s] phase=${GlobalStats.phase} GET=${get} (${getRate.toFixed(1)}/s) PATCH=${patch} (${patchRate.toFixed(1)}/s) | Stabilita: ${stabilityPct.toFixed(1)}% OK (${totalRetries} retry celkem) | HTTP: ${statuses} | Retries: ${retries}`);

        if (workerUrl && workerToken) {
            const payload = {
                running: true,
                phase: GlobalStats.phase,
                elapsedSeconds: elapsedS,
                requests: { GET: get, PATCH: patch },
                requestRatePerSec: { GET: Number(getRate.toFixed(2)), PATCH: Number(patchRate.toFixed(2)) },
                httpResponses: GlobalStats.httpResponses,
                retries: GlobalStats.retries,
                stabilityPct: Number(stabilityPct.toFixed(1)),
            };
            fetch(`${workerUrl}/v1/sync-stats`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${workerToken}` },
                body: JSON.stringify(payload),
            }).catch((e) => console.warn('[STATS] Odeslání do Workeru selhalo (neblokuje sync):', e.message));
        }
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

    console.log("=== STARTING FULL / INCREMENTAL SYNC ===");

    // CF_WORKER_URL/TOKEN musí být vždy nastavené v ostrém běhu (dryRun: false).
    // Bez nich by se zákaznické tier-změny zapsaly jen do lokálního souboru a Worker
    // by o nich nikdy nevěděl -- přesně tohle se stalo 2026-08-06 (7 zákazníků, viz
    // .customers_cache.json verze customers_2026-08-06_0056, nikdy neodeslaná).
    // Stejný důvod, proč cenová cache (cacheProvider) používá od 2026-08-12
    // RemotePriceCache místo FileCacheProvider -- soubor na disku GitHub Actions
    // runneru se mezi běhy nikdy nezachoval, takže diff proti Shoptet ceníku byl
    // naživo neúčinný (viz INCIDENTS.md INC-007).
    let customerCache;
    let cacheProvider;
    let forceSync;
    if (process.env.CF_WORKER_URL && process.env.CF_WORKER_TOKEN) {
        console.log("-> Using RemoteCustomerCache (CF Worker KV API)");
        customerCache = new RemoteCustomerCache(process.env.CF_WORKER_URL, process.env.CF_WORKER_TOKEN);
        console.log("-> Using RemotePriceCache (CF Worker KV API)");
        cacheProvider = new RemotePriceCache(process.env.CF_WORKER_URL, process.env.CF_WORKER_TOKEN);
        console.log("-> Using RemoteForceSync (CF Worker KV API)");
        forceSync = new RemoteForceSync(process.env.CF_WORKER_URL, process.env.CF_WORKER_TOKEN);
    } else {
        console.error("❌ CHYBA: Chybí CF_WORKER_URL a/nebo CF_WORKER_TOKEN.");
        console.error("Ostrý běh (dryRun: false) bez nich by zapsal zákaznické tiery jen lokálně -- Worker by se o změně nikdy nedozvěděl.");
        console.error("Nastav obě proměnné, nebo pro test bez Workeru spusť s DRY_RUN=1.");
        process.exit(1);
    }

    const isFullSyncRequested = process.argv.includes('--full') || process.env.FULL_SYNC === '1';
    let stateProvider;
    if (isFullSyncRequested) {
        console.log("-> Vynucen FULL SYNC (--full flag) — stahuji kompletní katalog a zákazníky bez filtru změn.");
        stateProvider = {
            getLastSync: async () => null,
            setLastSync: async (ts: string) => {
                const fs = await import('fs');
                const path = await import('path');
                fs.writeFileSync(path.join(process.cwd(), '.sync_state.json'), JSON.stringify({ lastSync: ts }, null, 2), 'utf8');
            }
        };
    }

    const orchestrator = new SyncOrchestrator({
        dryRun: false, // DŮLEŽITÉ: false znamená OSTRÝ BĚH (bude zapisovat PATCH requesty!)
        token: token,
        priceCache: cacheProvider,
        customerCache: customerCache,
        stateProvider: stateProvider,
        maxPages: undefined // Projdeme vše, co je potřeba
    });

    const statsTimer = startStatsReporter();
    let finished = false;
    try {
        await orchestrator.runFullSync();
        console.log("=== SYNCHRONIZACE DOKONČENA ===");
        finished = true;
    } catch (error) {
        // Previously this only logged the error and let the process exit 0 — in the
        // hourly GitHub Actions cron that meant a failed sync still showed as a green
        // checkmark (no failure-log artifact, no notification), so the pipeline could
        // silently stop working for hours/days with nobody noticing. Must propagate
        // the failure so the Actions step (and any future failure alerting) sees it.
        console.error("❌ CHYBA PŘI BĚHU:", error);
        GlobalStats.phase = 'error';
        process.exitCode = 1;
    } finally {
        clearInterval(statsTimer);
        console.log(`[STATS FINAL] GET=${GlobalStats.apiRequests.GET || 0} PATCH=${GlobalStats.apiRequests.PATCH || 0} | HTTP: ${JSON.stringify(GlobalStats.httpResponses)} | Retries: ${JSON.stringify(GlobalStats.retries)}`);
        if (process.env.CF_WORKER_URL && process.env.CF_WORKER_TOKEN) {
            await fetch(`${process.env.CF_WORKER_URL}/v1/sync-stats`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.CF_WORKER_TOKEN}` },
                body: JSON.stringify({
                    running: false,
                    phase: finished ? 'done' : 'error',
                    requests: { GET: GlobalStats.apiRequests.GET || 0, PATCH: GlobalStats.apiRequests.PATCH || 0 },
                    httpResponses: GlobalStats.httpResponses,
                    retries: GlobalStats.retries,
                }),
            }).catch(() => {});
        }
    }
    if (process.exitCode) process.exit(process.exitCode);
}

run().catch((error) => {
    // Safety net for any error thrown before/outside the try/catch above (e.g. a
    // synchronous throw during setup) — same reasoning: must not exit 0 on failure.
    console.error("❌ NEOČEKÁVANÁ CHYBA:", error);
    process.exit(1);
});
