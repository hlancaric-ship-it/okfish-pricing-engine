// Verifies the INCREMENTAL sync code path specifically (as opposed to the
// full-sync path already verified by verify-pricing-bridge-samples.ts).
// dryRun: true -- logs exactly what WOULD be sent to Shoptet's write API
// (PricelistWriter's [DIFF] lines: code, old price -> new price, per
// pricelist), never actually calls updatePricelistBatch. SyncOrchestrator
// never calls stateProvider.setLastSync() when dryRun is true, so the real
// .sync_state.json is safe to temporarily overwrite here and restore after.
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { SyncOrchestrator } from '../cloudflare-worker/src/shoptet-api/sync-orchestrator.ts';
import { FileCacheProvider } from '../cloudflare-worker/src/shoptet-api/cache-provider.ts';
import { RemoteCustomerCache, FileCustomerCache } from '../cloudflare-worker/src/shoptet-api/customer-cache.ts';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function run() {
    const hoursAgo = Number(process.env.HOURS_AGO || '2');
    const lastSync = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, '+0000');
    console.log(`=== INCREMENTÁLNÍ DRY RUN (od ${lastSync}, tj. ~${hoursAgo}h zpět) ===`);
    console.log('Nic se nezapíše, .sync_state.json se po běhu vrátí do původního stavu.');

    const stateFilePath = path.resolve(process.cwd(), '.sync_state.json');
    const originalState = fs.existsSync(stateFilePath) ? fs.readFileSync(stateFilePath, 'utf-8') : null;

    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) throw new Error('Chybí SHOPTET_PRIVATE_API_TOKEN.');

    const cacheProvider = new FileCacheProvider(path.resolve(process.cwd(), '.price_cache.json'));
    let customerCache;
    if (process.env.CF_WORKER_URL && process.env.CF_WORKER_TOKEN) {
        customerCache = new RemoteCustomerCache(process.env.CF_WORKER_URL, process.env.CF_WORKER_TOKEN);
    } else {
        customerCache = new FileCustomerCache();
    }

    try {
        fs.writeFileSync(stateFilePath, JSON.stringify({ lastSync }, null, 2), 'utf-8');

        const orchestrator = new SyncOrchestrator({
            dryRun: true,
            token,
            priceCache: cacheProvider,
            customerCache,
            maxPages: undefined,
        });

        await orchestrator.runFullSync();
    } finally {
        if (originalState !== null) fs.writeFileSync(stateFilePath, originalState, 'utf-8');
        else if (fs.existsSync(stateFilePath)) fs.unlinkSync(stateFilePath);
        console.log('[CLEANUP] .sync_state.json obnoven do původního stavu.');
    }

    console.log('=== HOTOVO ===');
}

run().catch((e) => { console.error('CHYBA:', e); process.exit(1); });
