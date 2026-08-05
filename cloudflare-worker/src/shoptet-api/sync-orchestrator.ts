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
    console.log(`   [manufacturer map] Stahuji feed: ${feedUrl}`);
    const startedAt = Date.now();
    // Hard timeout -- a hung/slow feed fetch must never block the whole sync
    // indefinitely (confirmed live 2026-08-06: first attempt stalled >5min with
    // zero API requests made, before this timeout existed).
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    let res: Response;
    try {
        res = await fetch(feedUrl, { signal: controller.signal });
    } catch (e) {
        console.warn(`[WARNING] Feed fetch selhal/timeout po ${Date.now() - startedAt}ms (${(e as Error).message}) -- brand discount caps will NOT be applied this run.`);
        return map;
    } finally {
        clearTimeout(timeout);
    }
    console.log(`   [manufacturer map] Feed odpověděl po ${Date.now() - startedAt}ms, status ${res.status}. Parsuji...`);
    if (!res.ok || !res.body) {
        console.warn(`[WARNING] Could not fetch master feed (HTTP ${res.status}) -- brand discount caps will NOT be applied this run.`);
        return map;
    }
    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();
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
        console.log(`\n3. Stahování produktů ze základního ceníku (ID: ${basePricelistId})...`);
        const productsReader = new ProductsReader(this.client);
        const sourceProducts = await productsReader.fetchProducts(basePricelistId, this.options.maxPages, lastSync);

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
        console.log('\n4. Stahování objednávek a výpočet obratu zákazníků...');
        const customerAdapter = new CustomerAdapter(this.client);
        const customerDiffsRaw = await customerAdapter.processCustomers(this.options.maxPages, lastSync, syncStartedAt);

        // 5. Výpočet cen (Pricing Engine Black Box)
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

        // BUG (opraveno): customerWriter.processDiff() zapisuje do KV cache jen
        // zákazníky, kterým se OPRAVDU změnil tier (customerDiffs je filtrované
        // customerDiffsRaw.filter(d => d.newTier !== d.oldTier)). To je v pořádku
        // pro INKREMENTÁLNÍ sync (nové klíče se jen přidají do už aktivní verze).
        // Ale FULL sync na konci accommitne() s isFullSync=true, což atomicky
        // přepne active_customer_version na tuhle novou (dosud jen z diffů
        // naplněnou) verzi — a tím zneviditelní úplně VŠECHNY zákazníky, kterým
        // se tier nezměnil (tj. drtivou většinu). Reálný dopad: po full syncu
        // najednou skoro všichni zákazníci dostávali 404 z /v1/discount/:hash
        // místo své skutečné slevy. Fix: při full syncu doplnit do cache i
        // všechny NEZMĚNĚNÉ zákazníky (customerDiffsRaw, ne jen customerDiffs).
        if (!this.options.dryRun && this.options.customerCache && isFullSync) {
            let unchangedWritten = 0;
            for (const d of customerDiffsRaw) {
                if (d.changed) continue; // ti už byli zapsáni v customerWriter.processDiff()
                if (!d.email) continue;
                const match = d.newTier.match(/ZR(\d+)/i);
                const discount = match ? parseInt(match[1], 10) : 0;
                await this.options.customerCache.setCustomerDiscount(d.email, discount);
                unchangedWritten++;
            }
            console.log(`[KV CACHE] Full sync: doplněno ${unchangedWritten} nezměněných zákazníků do nové verze cache (aby full-sync cutover nezneviditelnil jejich slevu).`);
        }

        if (!this.options.dryRun && this.options.customerCache && (customerStats.processed > 0 || isFullSync)) {
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
