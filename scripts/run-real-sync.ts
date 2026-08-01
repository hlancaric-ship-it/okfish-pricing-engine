import * as dotenv from 'dotenv';
import { SyncOrchestrator } from '../cloudflare-worker/src/shoptet-api/sync-orchestrator.ts';
import { FileCacheProvider } from '../cloudflare-worker/src/shoptet-api/cache-provider.ts';
import { RemoteCustomerCache, FileCustomerCache } from '../cloudflare-worker/src/shoptet-api/customer-cache.ts';
import * as path from 'path';

// Zkusíme načíst .env z kořenové složky
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

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

    try {
        await orchestrator.runFullSync();
        console.log("=== SYNCHRONIZACE DOKONČENA ===");
    } catch (error) {
        console.error("❌ CHYBA PŘI BĚHU:", error);
    }
}

run();
