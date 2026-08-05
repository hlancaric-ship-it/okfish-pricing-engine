// Dry-run version of scripts/run-real-sync.ts -- verifies what sync.yml WOULD
// write (customer tier changes + product price changes) without writing
// anything, ahead of re-enabling it after the 2026-08-06 pricing-bridge fix.
import * as dotenv from 'dotenv';
import { SyncOrchestrator } from '../cloudflare-worker/src/shoptet-api/sync-orchestrator.ts';
import { FileCacheProvider } from '../cloudflare-worker/src/shoptet-api/cache-provider.ts';
import { RemoteCustomerCache, FileCustomerCache } from '../cloudflare-worker/src/shoptet-api/customer-cache.ts';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function run() {
    console.log("=== DRY RUN SYNCHRONIZACE (nic se nezapíše) ===");

    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) {
        console.error("CHYBA: Chybí SHOPTET_PRIVATE_API_TOKEN.");
        process.exit(1);
    }

    const cacheProvider = new FileCacheProvider(path.resolve(process.cwd(), '.price_cache.json'));

    let customerCache;
    if (process.env.CF_WORKER_URL && process.env.CF_WORKER_TOKEN) {
        customerCache = new RemoteCustomerCache(process.env.CF_WORKER_URL, process.env.CF_WORKER_TOKEN);
    } else {
        customerCache = new FileCustomerCache();
    }

    const orchestrator = new SyncOrchestrator({
        dryRun: true,
        token,
        priceCache: cacheProvider,
        customerCache,
        maxPages: undefined,
    });

    await orchestrator.runFullSync();
    console.log("=== DRY RUN DOKONČEN ===");
}

run().catch((error) => {
    console.error("CHYBA:", error);
    process.exit(1);
});
