import { ShoptetApiClient } from './client';
import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';

export interface ShoptetProduct {
    code: string;
    price: Decimal;
    actionPrice?: Decimal;
    productMaxDiscount?: Decimal;
}

interface ForceSyncEntry {
    code: string;
    guid: string;
}

// Shoptet's /products/changes endpoint has been observed to never report a
// change event for some products created directly in the admin UI (seen
// with codes 99459 and 103525 on 2026-08-13 — confirmed absent from the
// changes list across a 2+ day window despite existing and being priced in
// the product export). Since incremental sync only ever looks at that
// endpoint, an affected product would otherwise be skipped forever. This
// file is a manual escape hatch: codes listed here get their detail
// fetched and merged in on every incremental run regardless of what the
// changes API reports, and the list is cleared automatically once they've
// been synced (see SyncOrchestrator).
const FORCE_SYNC_FILE = path.join(process.cwd(), 'force-sync-products.json');

export function loadForceSyncEntries(): ForceSyncEntry[] {
    try {
        if (!fs.existsSync(FORCE_SYNC_FILE)) return [];
        const raw = fs.readFileSync(FORCE_SYNC_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((e): e is ForceSyncEntry => !!e?.code && !!e?.guid);
    } catch (e) {
        console.warn(`[ForceSync] Nepodařilo se načíst ${FORCE_SYNC_FILE}, pokračuji bez něj:`, e);
        return [];
    }
}

export class ProductsReader {
    constructor(private readonly apiClient: ShoptetApiClient) {}

    /**
     * Stáhne produkty (plně nebo inkrementálně, pokud je k dispozici lastSync).
     */
    public async fetchProducts(pricelistId: number, maxPages?: number, lastSync?: string | null): Promise<ShoptetProduct[]> {
        if (lastSync) {
            console.log(`ProductsReader: INKREMENTÁLNÍ REŽIM - Hledám změněné produkty od ${lastSync}...`);
            const changes = await this.apiClient.getProductChanges(lastSync);
            
            if (changes.length === 0) {
                console.log(`ProductsReader: Žádné produkty nebyly od ${lastSync} změněny.`);
                return []; // Vrátí prázdné pole, orchestrátor podle toho vynechá pricing engine
            }

            console.log(`ProductsReader: Nalezeno ${changes.length} změn produktů. Stahuji detaily (s ohledem na rate limity)...`);
            const products: ShoptetProduct[] = [];
            
            let processed = 0;
            for (const change of changes) {
                processed++;
                if (processed % 50 === 0) console.log(`   Stahuji detail produktu ${processed}/${changes.length}`);
                
                if (change.changeType === 'delete') continue;
                
                const detail = await this.apiClient.getProductDetail(change.guid);
                if (!detail) continue;

                // BUG (opraveno): GET /api/products/{guid} nemá žádná cenová pole na
                // top-level `detail.price` / `detail.sales` — podle Shoptet OpenAPI
                // schématu (`product`) tahle pole na produktu vůbec neexistují. Cenová
                // data (cena i sales.minPriceRatio — strop max. slevy) jsou dostupná
                // JEN přes `?include=perPricelistPrices` (viz getProductDetail), a to
                // jako POLE `perPricelistPrices[]`, jeden záznam na ceník, s vlastním
                // `pricelistId`. Předchozí kód četl neexistující top-level pole, takže
                // pro KAŽDÝ produkt, co prošel inkrementální synchronizací (= byl od
                // poslední synchronizace upravený), tiše spadl na basePrice=0 a
                // productMaxDiscount=undefined — tím zmizel strop slevy (např. 5 %) a
                // loajalitní tier (např. ZR25 = -25 %) se pak uplatnil neomezeně.
                const pricelistEntry = Array.isArray(detail.perPricelistPrices)
                    ? detail.perPricelistPrices.find((p: any) => p.pricelistId === pricelistId)
                    : undefined;

                let basePrice = 0;
                let actPrice: number | undefined = undefined;
                let productMaxDiscount: Decimal | undefined = undefined;

                if (pricelistEntry) {
                    basePrice = parseFloat(pricelistEntry.price?.price ?? "0") || 0;
                    const actionPriceVal = pricelistEntry.price?.actionPrice?.price;
                    if (actionPriceVal !== null && actionPriceVal !== undefined) {
                        actPrice = parseFloat(actionPriceVal);
                    }
                    const ratio = pricelistEntry.sales?.minPriceRatio;
                    if (ratio !== null && ratio !== undefined) {
                        const ratioNum = parseFloat(ratio);
                        if (!isNaN(ratioNum) && ratioNum <= 1) {
                            productMaxDiscount = new Decimal(1).minus(new Decimal(ratioNum));
                        }
                    }
                } else {
                    console.warn(`ProductsReader: Produkt ${change.guid} nemá záznam perPricelistPrices pro ceník ${pricelistId} — přeskakuji cenová data (bude dořešeno při dalším full syncu).`);
                }

                products.push({
                    code: detail.code || change.code || change.guid,
                    price: new Decimal(basePrice),
                    actionPrice: actPrice !== undefined ? new Decimal(actPrice) : undefined,
                    productMaxDiscount
                });
            }

            const forceEntries = loadForceSyncEntries();
            const alreadyCovered = new Set(products.map(p => p.code));
            for (const entry of forceEntries) {
                if (alreadyCovered.has(entry.code)) continue;
                console.log(`ProductsReader: [ForceSync] Doplňuji produkt ${entry.code}, chybí v Shoptet changes API.`);
                const detail = await this.apiClient.getProductDetail(entry.guid);
                if (!detail) {
                    console.warn(`ProductsReader: [ForceSync] Produkt ${entry.code} (guid ${entry.guid}) nenalezen v API.`);
                    continue;
                }
                const basePrice = detail.price ? parseFloat(detail.price.withVat || detail.price.withoutVat || "0") : 0;
                products.push({ code: detail.code || entry.code, price: new Decimal(basePrice) });
            }

            console.log(`ProductsReader: Staženo a zpracováno ${products.length} změněných produktů.`);
            return products;

        }

        console.log(`ProductsReader: FULL SYNC - Stahování všech produktů pro ceník ID ${pricelistId}...`);
        const items = await this.apiClient.getPricelistProducts(pricelistId, maxPages);
        
        const products: ShoptetProduct[] = items.map(item => {
            const basePrice = item.price?.price ? item.price.price : 0;
            const actPrice = item.price?.actionPrice?.price;
            let productMaxDiscount: Decimal | undefined = undefined;
            if (item.sales?.minPriceRatio) {
                const ratio = parseFloat(item.sales.minPriceRatio);
                if (!isNaN(ratio) && ratio <= 1) {
                    productMaxDiscount = new Decimal(1).minus(new Decimal(ratio));
                }
            }
            return {
                code: item.code,
                price: new Decimal(basePrice),
                actionPrice: actPrice !== null && actPrice !== undefined ? new Decimal(actPrice) : undefined,
                productMaxDiscount
            };
        });

        console.log(`ProductsReader: Staženo ${products.length} produktů z ceníku ID ${pricelistId}.`);
        return products;
    }
}
