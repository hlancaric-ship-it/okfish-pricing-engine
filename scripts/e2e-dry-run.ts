import { SyncOrchestrator } from '../cloudflare-worker/src/shoptet-api/sync-orchestrator.ts';
import * as dotenv from 'dotenv';
import { FileCacheProvider } from '../cloudflare-worker/src/shoptet-api/cache-provider.ts';

// Načtení environment variables ze souboru .env
dotenv.config();

async function main() {
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) {
        console.error('CHYBA: SHOPTET_PRIVATE_API_TOKEN není nastaven v .env');
        process.exit(1);
    }

    const priceCache = new FileCacheProvider('./.cache/state.json');

    // Inicializace orchestrátoru v OSTRÉM REŽIMU (ZÁPIS POVOLEN) bez omezení stránek pro FULL TEST
    const orchestrator = new SyncOrchestrator({
        dryRun: false,
        token: token,
        priceCache,
        maxPages: undefined
    });

    try {
        console.log('=== SPUŠTĚNÍ OSTRÉ SYNCHRONIZACE (LIVE: Zápis povolen) ===\n');
        await orchestrator.runFullSync();
        console.log('\n[OK] E2E LIVE Run úspěšně dokončen.');
    } catch (err: any) {
        console.error('\n[FATAL ERROR] E2E Dry Run selhal:', err);
        process.exit(1);
    }
}

main();
