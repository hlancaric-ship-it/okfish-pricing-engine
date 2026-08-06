import { ShoptetApiClient, GlobalStats } from './client';
import { CustomerWriter, CustomerDiff } from './customer-writer';
import { PricelistWriter, PricelistDiff } from './pricelist-writer';
import { CustomerAdapter } from './customer-adapter';
import { ProductsReader } from './products-reader';
import { calculateProductsPricing } from './pricing-bridge';
import { ICacheProvider } from './cache-provider';
import { ICustomerCache } from './customer-cache';
import { FileStateProvider, ISyncStateProvider } from './state-provider';
import { CsvParserStream } from '../csv/csv-parser';
import Decimal from 'decimal.js';

// The Shoptet Private API's pricelist-items endpoint (used by ProductsReader)
// never returns `manufacturer` -- it's a product-catalog attribute, not a
// pricing one. Without it, DiscountLimitPolicy's brand fallback (brandLimits
// in policy-v1.json) can never trigger, silently disabling the discount cap
// for every hard-cap brand (confirmed live 2026-08-06: LOWRANCE showed 6%
// off on ZR6 despite its 4% cap, because manufacturer was never wired
// through this sync pipeline at all). Fetch it once from the public feed
// (code -> manufacturer) and merge it in below.
async function loadManufacturerMap(): Promise<Record<string, string>> {
    const feedUrl = process.env.MASTER_FEED_URL;
    const map: Record<string, string> = {};
    if (!feedUrl) {
        console.warn('[WARNING] MASTER_FEED_URL not set -- brand discount caps will NOT be applied this run.');
        return map;
    }

    const startedAt = Date.now();
    let reader: ReadableStreamDefaultReader | undefined;

    const doFetch = async (): Promise<Record<string, string>> => {
        console.log(`   [manufacturer map] Stahuji feed: ${feedUrl}`);
        const res = await fetch(feedUrl);
        console.log(`   [manufacturer map] Feed odpověděl po ${Date.now() - startedAt}ms, status ${res.status}. Parsuji...`);
        if (!res.ok || !res.body) {
            console.warn(`[WARNING] Could not fetch master feed (HTTP ${res.status}) -- brand discount caps will NOT be applied this run.`);
            return map;
        }
        const parsed = res.body.pipeThrough(new CsvParserStream());
        reader = parsed.getReader();
        let scanned = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const row = value as Record<string, string>;
            if (row['code'] && row['manufacturer']) map[row['code']] = row['manufacturer'];
            scanned++;
            if (scanned % 4000 === 0) console.log(`   [manufacturer map] ...zpracováno ${scanned} řádků (${Date.now() - startedAt}ms)`);
        }
        console.log(`   [manufacturer map] Hotovo: ${scanned} řádků, ${Object.keys(map).length} s manufacturer, za ${Date.now() - startedAt}ms.`);
        return map;
    };

    // Hard timeout wrapping the WHOLE operation (fetch + stream read), not just
    // the initial fetch() call -- confirmed live 2026-08-06: a timeout on fetch()
    // alone did nothing because the connection opened fine and the STREAM READ
    // itself stalled afterwards (>3min, zero Shoptet API requests made the whole
    // time). If this fires, whatever's in `map` so far is used as-is (partial
    // data is still better than none) and the reader is cancelled to free the
    // connection.
    const timeoutMs = 120000;
    const timeoutPromise = new Promise<Record<string, string>>((resolve) => {
        setTimeout(() => {
            console.warn(`[WARNING] Manufacturer-map feed operation přesáhla ${timeoutMs}ms (zaseklo se na čtení, ne na fetch) -- pokračuji s ${Object.keys(map).length} zatím načtenými kódy.`);
            reader?.cancel().catch(() => {});
            resolve(map);
        }, timeoutMs);
    });

    return Promise.race([doFetch(), timeoutPromise]);
}

export interface SyncOptions {
    dryRun: boolean;
    token: string;
    priceCache: ICacheProvider;
    customerCache?: ICustomerCache;
    maxPages?: number;
}

export class SyncOrchestrator {
    private client: ShoptetApiClient;

    constructor(private readonly options: SyncOptions) {
        this.client = new ShoptetApiClient(options.token);
    }

    public async runFullSync(): Promise<void> {
        console.log(`\n=== SPUŠTĚNÍ SYNCHRONIZACE (DryRun: ${this.options.dryRun}) ===\n`);
        const startTime = Date.now();
        // Shoptet expects format without milliseconds: YYYY-MM-DDThh:mm:ss+0000
        const syncStartedAt = new Date(startTime).toISOString().replace(/\.\d{3}Z$/, '+0000');
        
        GlobalStats.phase = 'state-read';
        const stateProvider: ISyncStateProvider = new FileStateProvider();
        const rawLastSync = await stateProvider.getLastSync();
        let lastSync = rawLastSync;
        
        if (rawLastSync) {
            // 5 minutový přesah (overlap) pro jistotu
            const overlapMs = 5 * 60 * 1000;
            const lastSyncDate = new Date(new Date(rawLastSync).getTime() - overlapMs);
            lastSync = lastSyncDate.toISOString().replace(/\.\d{3}Z$/, '+0000');
            console.log(`\n[INKREMENTÁLNÍ MÓD] Poslední úspěšná synchronizace: ${rawLastSync} (použije se s přesahem: ${lastSync})`);
        } else {
            console.log(`\n[FULL SYNC MÓD] První spuštění (žádný lastSync nenalezen)`);
        }

        // 1. Načtení seznamu ceníků
        GlobalStats.phase = 'pricelists';
        console.log('1. Stahování seznamu ceníků ze Shoptet API...');
        let pricelists;
        try {
            pricelists = await this.client.getPricelists();
            if (!pricelists || pricelists.length === 0) {
                throw new Error("API nevrátilo žádné ceníky.");
            }
        } catch (error) {
            console.error('\n[FATAL ERROR] Nepodařilo se načíst seznam ceníků z API. Zápisová vrstva se okamžitě ukončuje.');
            return;
        }

        // 2. Vytvoření mapy ceníků (name -> id)
        console.log('2. Vytváření dynamické mapy ceníků a zákaznických skupin v paměti...');
        const pricelistNameMap: Record<string, number> = {};
        for (const pl of pricelists) {
            pricelistNameMap[pl.name] = pl.id;
        }
        
        GlobalStats.phase = 'customer-groups';
        let customerGroups;
        try {
            customerGroups = await this.client.getCustomerGroups();
        } catch (error) {
            console.warn('[WARNING] Nepodařilo se načíst seznam zákaznických skupin z API. Pokračuji bez aktualizace skupin.');
            customerGroups = [];
        }
        
        const customerGroupMap: Record<string, string> = {};
        for (const cg of customerGroups) {
            customerGroupMap[cg.name] = cg.customerGroupCode;
        }

        console.log(`   Nalezeno ${pricelists.length} ceníků a ${customerGroups.length} zákaznických skupin. Mapy inicializovány.`);

        // Nastavení výchozího ceníku pro výpočty ("Maloobchodný" nebo první v seznamu)
        const basePricelistName = 'Maloobchodný';
        const basePricelistId = pricelistNameMap[basePricelistName] || pricelists[0].id; 

        // 3. Načtení produktů
        GlobalStats.phase = 'fetch-products';
        console.log(`\n3. Stahování produktů ze základního ceníku (ID: ${basePricelistId})...`);
        const productsReader = new ProductsReader(this.client);
        const sourceProducts = await productsReader.fetchProducts(basePricelistId, this.options.maxPages, lastSync);

        GlobalStats.phase = 'manufacturer-map';
        console.log('   Stahování feedu pro mapování manufacturer (nutné pro brandLimits stropy)...');
        const manufacturerMap = await loadManufacturerMap();
        console.log(`   Načteno ${Object.keys(manufacturerMap).length} kódů s manufacturer.`);

        const engineProducts = sourceProducts.map(p => ({
            code: p.code,
            basePrice: p.price,
            actionPrice: p.actionPrice,
            productMaxDiscount: p.productMaxDiscount,
            manufacturer: manufacturerMap[p.code],
            stockLevel: 100 // Mock nebo z dat
        }));

        // 4. Načtení zákazníků
        GlobalStats.phase = 'customer-orders';
        console.log('\n4. Stahování objednávek a výpočet obratu zákazníků...');
        const customerAdapter = new CustomerAdapter(this.client);
        const customerDiffsRaw = await customerAdapter.processCustomers(this.options.maxPages, lastSync, syncStartedAt);

        // 5. Výpočet cen (Pricing Engine Black Box)
        GlobalStats.phase = 'pricing-engine';
        let calculated: any[] = [];
        if (engineProducts.length > 0) {
            console.log('\n5. Spouštění výpočtu Pricing Engine...');
            calculated = calculateProductsPricing(engineProducts, pricelists);
        } else {
            console.log('\n5. Optimalizace: Žádné produkty ke změně, vynechávám Pricing Engine.');
        }

        // 6. Výpočet změn (Diff)
        console.log('\n6. Výpočet změn (Diff)...');

        // 6a. Diff zákazníků
        const customerDiffs: CustomerDiff[] = customerDiffsRaw
            .filter(d => d.newTier !== d.oldTier) // Jen opravdové změny
            .map(d => ({
                customerGuid: d.customerGuid,
                customerName: 'N/A',
                oldTier: d.oldTier,
                newTier: d.newTier,
                oldPricelistId: d.oldTier && pricelistNameMap[d.oldTier] ? pricelistNameMap[d.oldTier] : null,
                newPricelistId: pricelistNameMap[d.newTier] || 0
            }));

        // 6b. Diff ceníků pomocí Cache
        const pricelistDiffsByMap: Record<number, { name: string, diffs: PricelistDiff[] }> = {};
        for (const pl of pricelists) {
            if (pl.id === basePricelistId) continue;
            
            const diffs: PricelistDiff[] = [];

            for (const item of calculated) {
                const newPriceStr = item.prices[pl.name];
                if (!newPriceStr) continue;

                const newPrice = new Decimal(newPriceStr);
                
                // Rychlý lookup do naší lokální Cache (0 API requestů)
                const oldPriceStr = await this.options.priceCache.getPrice(pl.id, item.code);
                const oldPrice = oldPriceStr ? new Decimal(oldPriceStr) : null;

                if (!oldPrice || !oldPrice.equals(newPrice)) {
                    diffs.push({
                        code: item.code,
                        oldPrice,
                        newPrice
                    });
                }
            }
            pricelistDiffsByMap[pl.id] = { name: pl.name, diffs };
        }

        // 7 + 8. Dry Run & WRITE
        console.log('\n7. Spouštění aplikace změn (Writers)...');
        if (this.options.dryRun) {
            console.log('   !!! UPOZORNĚNÍ: Běží pouze DRY RUN, žádná data nebudou zapsána !!!');
        }

        const customerWriter = new CustomerWriter(this.client, {
            dryRun: this.options.dryRun,
            pricelistNameMap,
            customerGroupMap,
            customerCache: this.options.customerCache
        });
        const customerStats = await customerWriter.processDiff(customerDiffs);

        const isFullSync = !rawLastSync;

        // BUG (opraveno 2026-08-06): customerWriter.processDiff() zapisuje do KV
        // cache jen zákazníky, kterým se OPRAVDU změnil tier (customerDiffs je
        // filtrované customerDiffsRaw.filter(d => d.newTier !== d.oldTier)).
        // Při FULL syncu se to řešilo o pár řádků níž (commit s isFullSync=true
        // atomicky přepíná active_customer_version, takže by cutover zneviditelnil
        // všechny nezměněné zákazníky). Ale stejná mezera existovala i v
        // INKREMENTÁLNÍM syncu -- tam commit() jen doplňuje klíče do JIŽ aktivní
        // verze (bezpečné, žádný cutover), takže nebyl důvod nezměněné přeskakovat.
        // Reálný dopad: nový zákazník, kterého Shoptet rovnou zařadí do ZR4 (stejný
        // tier, jaký spočítá i náš engine z nulového obratu -> changed:false), se
        // do KV nezapsal VŮBEC, natrvalo -- webhook i sync proběhly, ale
        // /v1/discount/:hash pro něj napořád vracelo 404 (potvrzeno živě
        // honzalufx@gmail.com, run 31065863713). Fix: zapisovat nezměněné
        // zákazníky do KV vždy, nejen při full syncu.
        let unchangedWritten = 0;
        if (!this.options.dryRun && this.options.customerCache) {
            for (const d of customerDiffsRaw) {
                if (d.changed) continue; // ti už byli zapsáni v customerWriter.processDiff()
                if (!d.email) continue;
                const match = d.newTier.match(/ZR(\d+)/i);
                const discount = match ? parseInt(match[1], 10) : 0;
                await this.options.customerCache.setCustomerDiscount(d.email, discount);
                unchangedWritten++;
            }
            if (unchangedWritten > 0) {
                console.log(`[KV CACHE] Doplněno ${unchangedWritten} nezměněných zákazníků do cache (${isFullSync ? 'full sync' : 'inkrementální sync'}).`);
            }
        }

        if (!this.options.dryRun && this.options.customerCache && (customerStats.processed > 0 || isFullSync || unchangedWritten > 0)) {
            const version = `customers_${new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').substring(0, 15)}`;
            await this.options.customerCache.commit(version, isFullSync);
            console.log(`[KV CACHE] Zákaznická cache byla zapsána pod verzí ${version}`);
        }

        const pricelistWriter = new PricelistWriter(this.client, {
            dryRun: this.options.dryRun
        });

        const pricelistStatsList = [];
        for (const plIdStr in pricelistDiffsByMap) {
            const plId = parseInt(plIdStr, 10);
            const plData = pricelistDiffsByMap[plId];
            const pStats = await pricelistWriter.processDiff(plId, plData.name, plData.diffs);
            pricelistStatsList.push(pStats);

            // Po úspěšném zápisu zaktualizujeme Cache!
            if (!this.options.dryRun && pStats.processed > 0) {
                for (const d of plData.diffs) {
                    await this.options.priceCache.setPrice(plId, d.code, d.newPrice.toFixed(2));
                }
            }
        }

        // Uložení všech změn z cache na disk (pro FileCache)
        if (!this.options.dryRun) {
            await this.options.priceCache.commit();
        }

        const endTimeStr = new Date().toISOString();
        const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

        let totalPricelistUpdates = 0;
        let totalPricelistFails = 0;
        let totalPricelistSkipped = 0;
        let totalBatches = 0;
        for (const p of pricelistStatsList) {
            totalPricelistUpdates += p.processed;
            totalPricelistFails += p.failed;
            totalPricelistSkipped += p.skipped;
            totalBatches += Math.ceil(p.processed / 100);
        }

        const avgBatchSize = totalBatches > 0 ? (totalPricelistUpdates / totalBatches).toFixed(1) : "0";

        console.log('\n==========================');
        console.log('FULL SYNC REPORT');
        console.log('==========================\n');
        
        console.log(`Start: ${new Date(startTime).toISOString()}`);
        console.log(`End: ${endTimeStr}`);
        console.log(`Duration: ${durationSec}s\n`);

        console.log(`Products loaded: ${sourceProducts.length}`);
        console.log(`Products processed: ${totalPricelistUpdates + totalPricelistSkipped + totalPricelistFails}`);
        console.log(`Products updated: ${totalPricelistUpdates}`);
        console.log(`Products skipped: ${totalPricelistSkipped}`);
        console.log(`Products failed: ${totalPricelistFails}\n`);

        console.log(`Pricelists processed: ${pricelistStatsList.length}`);
        console.log(`Batch requests: ${totalBatches}`);
        console.log(`Average batch size: ${avgBatchSize}\n`);

        console.log(`Customers loaded: ${customerDiffsRaw.length}`);
        console.log(`Customers processed: ${customerStats.processed + customerStats.skipped + customerStats.failed}`);
        console.log(`Customers updated: ${customerStats.processed}`);
        console.log(`Customers skipped: ${customerStats.skipped}`);
        console.log(`Customers failed: ${customerStats.failed}\n`);

        console.log(`Orders loaded: ${GlobalStats.ordersLoaded}`);
        console.log(`Turnover calculated: ${GlobalStats.turnoverCalculated.toFixed(2)}\n`);

        console.log('API requests:');
        console.log(`GET: ${GlobalStats.apiRequests.GET}`);
        console.log(`PATCH: ${GlobalStats.apiRequests.PATCH}\n`);

        console.log('HTTP responses:');
        const trackedCodes = [200, 204, 400, 401, 403, 404, 409, 413, 422, 423, 429, 500, 503, 504];
        for (const code of trackedCodes) {
            console.log(`${code}: ${GlobalStats.httpResponses[code] || 0}`);
        }
        console.log();

        console.log('Retries:');
        const retryCodes = [429, 500, 503, 504];
        for (const code of retryCodes) {
            console.log(`${code}: ${GlobalStats.retries[code] || 0}`);
        }
        console.log();

        console.log(`Audit logs generated: ${GlobalStats.auditLogs}`);
        console.log(`Rollback snapshots created: ${GlobalStats.rollbackSnapshots}\n`);

        const memoryUsage = process.memoryUsage ? Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB' : 'N/A';
        console.log(`Peak memory: ${memoryUsage}`);
        console.log(`Execution time: ${durationSec}s\n`);

        const isSuccess = (totalPricelistFails === 0 && customerStats.failed === 0);
        console.log(`FINAL RESULT:`);
        console.log(`${isSuccess ? 'SUCCESS' : 'FAILED'}\n`);

        console.log(`READY FOR PRODUCTION:`);
        if (isSuccess && !this.options.dryRun) {
            console.log(`YES`);
            // Zapíšeme state pouze pokud neselhal ani jeden zápis!
            await stateProvider.setLastSync(syncStartedAt);
            console.log(`[State] Uložen nový lastSync: ${syncStartedAt}`);
        } else {
            console.log(`NO`);
            if (this.options.dryRun) console.log(`- Zrušte dryRun flag pro ostrý běh (lastSync nebyl zapsán)`);
            if (totalPricelistFails > 0) console.log(`- Selhal zápis produktů (${totalPricelistFails})`);
            if (customerStats.failed > 0) console.log(`- Selhal zápis zákazníků (${customerStats.failed})`);
        }
        console.log();
    }
}
