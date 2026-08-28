import { ShoptetApiClient, GlobalStats } from './client';
import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';

export interface ShoptetProduct {
    code: string;
    price: Decimal;
    actionPrice?: Decimal;
    productMaxDiscount?: Decimal;
    vatRate?: string;
    includingVat?: boolean;
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
     * `extraCodes` obsahuje dodatečné kódy produktů k přehodnocení (např. z důvodu změny pricing pravidel).
     * `incompleteCodes` obsahuje kódy produktů, které SE ZMĚNILY, ale Shoptet pro ně
     * ještě nevrátil perPricelistPrices na základním ceníku (typicky produkt založený
     * jen pár minut/hodin předtím — propagace do ceníku má u Shoptetu zpoždění).
     * Tyto produkty se NESMÍ zapsat s vyfabrikovanou basePrice=0 (viz INCIDENT
     * 2026-08-12: 99459 a 103525 přidané Yopni skončily s nulovou/nedopočítanou cenou
     * na wholesale ceníku a nikdo si toho nevšiml, protože run doběhl jako "success").
     * Orchestrátor musí tyto kódy zohlednit a NEPOSOUVAT lastSync dál, dokud se
     * nedopočítají — jinak zmizí z dalšího inkrementálního okna navždy.
     */
    public async fetchProducts(
        pricelistId: number,
        maxPages?: number,
        lastSync?: string | null,
        extraCodes?: string[]
    ): Promise<{ products: ShoptetProduct[]; incompleteCodes: string[] }> {
        if (lastSync) {
            console.log(`ProductsReader: INKREMENTÁLNÍ REŽIM - Hledám změněné produkty od ${lastSync}...`);
            const changes = await this.apiClient.getProductChanges(lastSync);
            const products: ShoptetProduct[] = [];
            const incompleteCodes: string[] = [];

            // BUG (opraveno 2026-08-13): dřív se tady dělal `return` hned, pokud
            // `changes.length === 0` -- TAKŽE se force-sync smyčka níže (pro produkty,
            // co Shoptet /products/changes vůbec nikdy nenahlásí, viz FORCE_SYNC_FILE)
            // nikdy nespustila, kdykoli nebyly žádné běžné změny. force-sync-products.json
            // se přitom orchestrátorem stejně vyčistil jako "úspěšně zpracováno" -- takže
            // 99459/103525 zůstaly navěky nedopočítané, i když byly ve force-sync listu
            // (potvrzeno živě: běh 2026-08-13 09:00 UTC, "Products loaded: 0", žádný
            // "[ForceSync] Doplňuji produkt" v logu, a přesto se soubor vyčistil).
            // Teď se force-sync smyčka spustí VŽDY, bez ohledu na to, kolik běžných
            // změn Shoptet nahlásil.
            if (changes.length === 0) {
                console.log(`ProductsReader: Žádné produkty nebyly od ${lastSync} změněny.`);
            } else {
                console.log(`ProductsReader: Nalezeno ${changes.length} změn produktů. Stahuji detaily (s ohledem na rate limity)...`);
            }

            let processed = 0;
            for (const change of changes) {
                processed++;
                if (processed % 50 === 0 || processed === 1 || processed === changes.length) {
                    console.log(`   Stahuji detail produktu ${processed}/${changes.length}`);
                    GlobalStats.phase = `fetch-products (${processed}/${changes.length})`;
                }

                if (change.changeType === 'delete') continue;

                const detail = await this.apiClient.getProductDetail(change.guid);
                if (!detail) {
                    // Produkt nenalezen (smazaný, nebo API selhalo bez chyby) -- dřív se
                    // tohle tiše přeskočilo bez záznamu. Teď se počítá jako incomplete,
                    // aby to bylo vidět a produkt se zkusil znovu příští synchronizací.
                    const fallbackCode = change.code || change.guid;
                    console.warn(`ProductsReader: Produkt ${fallbackCode} (${change.guid}) -- getProductDetail() nevrátil data -- VYNECHÁVÁM, zkusí se znovu příští synchronizací.`);
                    incompleteCodes.push(fallbackCode);
                    continue;
                }

                // BUG (opraveno 2026-08-13): GET /api/products/{guid}?include=perPricelistPrices
                // nemá `perPricelistPrices` na top-level produktu -- je to pole UVNITŘ
                // KAŽDÉ VARIANTY (`detail.variants[].perPricelistPrices`), podle Shoptet
                // OpenAPI schématu potvrzeného živě na 99459/103525 (top-level `detail` má
                // ani `code`, jen `guid`/`variants[]`/popisná pole). Stejná chyba jako
                // `client.ts`'s `json.data.product` -- obě objeveny při vyšetřování INC-010.
                const variant = Array.isArray(detail.variants)
                    ? (detail.variants.find((v: any) => v.code === change.code) || detail.variants[0])
                    : undefined;

                const pricelistEntry = Array.isArray(variant?.perPricelistPrices)
                    ? variant.perPricelistPrices.find((p: any) => p.pricelistId === pricelistId)
                    : undefined;

                const code = variant?.code || detail.code || change.code || change.guid;

                if (!pricelistEntry) {
                    // Nefabrikujeme basePrice=0 -- to by se dřív dopočítalo a ZAPSALO
                    // jako platná (nulová/nesprávná) cena na wholesale ceník beze stopy.
                    // Místo toho produkt vynecháváme z tohoto běhu úplně a hlásíme ho
                    // nahoru jako "incomplete" -- orchestrátor kvůli tomu nepustí
                    // lastSync dál, takže se produkt bude zkoušet znovu každých 15 min,
                    // dokud Shoptet perPricelistPrices nedoplní.
                    console.warn(`ProductsReader: Produkt ${code} (${change.guid}) nemá záznam perPricelistPrices pro ceník ${pricelistId} -- VYNECHÁVÁM z tohoto běhu, bude zkusen znovu příští synchronizací.`);
                    incompleteCodes.push(code);
                    continue;
                }

                const basePrice = parseFloat(pricelistEntry.price?.price ?? "0") || 0;
                let actPrice: number | undefined = undefined;
                let productMaxDiscount: Decimal | undefined = undefined;

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

                const vatRate = pricelistEntry.vatRate || detail.vatRate || "23.00";
                const includingVat = pricelistEntry.includingVat !== undefined ? pricelistEntry.includingVat : true;

                products.push({
                    code,
                    price: new Decimal(basePrice),
                    actionPrice: actPrice !== undefined ? new Decimal(actPrice) : undefined,
                    productMaxDiscount,
                    vatRate,
                    includingVat
                });
            }

            // Re-evaluace produktů dotčených změnou pricing pravidel / overrides
            if (extraCodes && extraCodes.length > 0) {
                const covered = new Set(products.map(p => p.code));
                for (let i = 0; i < extraCodes.length; i++) {
                    const code = extraCodes[i];
                    if (covered.has(code) || incompleteCodes.includes(code)) continue;
                    GlobalStats.phase = `config-re-evaluate (${i + 1}/${extraCodes.length})`;
                    console.log(`ProductsReader: [RuleChange] Doplňuji produkt ${code} k přehodnocení po změně pricing pravidel.`);

                    try {
                        const item = await this.apiClient.getPricelistItemByCode(pricelistId, code);
                        if (!item) {
                            console.warn(`ProductsReader: [RuleChange] Produkt ${code} nemá záznam na ceníku ${pricelistId} -- VYNECHÁVÁM.`);
                            incompleteCodes.push(code);
                            continue;
                        }
                        const basePrice = parseFloat(item.price?.price ?? "0") || 0;
                        let actPrice: number | undefined = undefined;
                        let productMaxDiscount: Decimal | undefined = undefined;
                        const actionPriceVal = item.price?.actionPrice?.price;
                        if (actionPriceVal !== null && actionPriceVal !== undefined) actPrice = parseFloat(actionPriceVal);
                        const ratio = item.sales?.minPriceRatio;
                        if (ratio !== null && ratio !== undefined) {
                            const ratioNum = parseFloat(ratio);
                            if (!isNaN(ratioNum) && ratioNum <= 1) productMaxDiscount = new Decimal(1).minus(new Decimal(ratioNum));
                        }
                        const vatRate = item.vatRate || "23.00";
                        const includingVat = item.includingVat !== undefined ? item.includingVat : true;

                        products.push({
                            code: item.code || code,
                            price: new Decimal(basePrice),
                            actionPrice: actPrice !== undefined ? new Decimal(actPrice) : undefined,
                            productMaxDiscount,
                            vatRate,
                            includingVat
                        });
                        covered.add(code);
                    } catch (e: any) {
                        console.warn(`ProductsReader: [RuleChange] Chyba při stahování produktu ${code}:`, e.message || e);
                        incompleteCodes.push(code);
                    }
                }
            }

            // Escape hatch pro produkty, které Shoptet /products/changes API vůbec
            // nikdy nenahlásí (pozorováno u 99459 a 103525, 2026-08-13 -- chyběly
            // v changes listu přes 2 dny, přestože reálně existovaly a měly cenu).
            // Ručně dopsané kódy v force-sync-products.json se stáhnou vždy navíc,
            // stejnou pricelistEntry logikou jako běžné změny (aby i ony podléhaly
            // incompleteCodes ochraně výše místo fabrikace basePrice=0).
            const forceEntries = loadForceSyncEntries();
            const alreadyCovered = new Set(products.map(p => p.code));
            for (let i = 0; i < forceEntries.length; i++) {
                const entry = forceEntries[i];
                if (alreadyCovered.has(entry.code) || incompleteCodes.includes(entry.code)) continue;
                GlobalStats.phase = `force-sync-product (${i + 1}/${forceEntries.length})`;
                console.log(`ProductsReader: [ForceSync] Doplňuji produkt ${entry.code}, chybí v Shoptet changes API.`);
                const detail = await this.apiClient.getProductDetail(entry.guid);
                if (!detail) {
                    console.warn(`ProductsReader: [ForceSync] Produkt ${entry.code} (guid ${entry.guid}) nenalezen v API.`);
                    incompleteCodes.push(entry.code);
                    continue;
                }
                const variant = Array.isArray(detail.variants)
                    ? (detail.variants.find((v: any) => v.code === entry.code) || detail.variants[0])
                    : undefined;
                const pricelistEntry = Array.isArray(variant?.perPricelistPrices)
                    ? variant.perPricelistPrices.find((p: any) => p.pricelistId === pricelistId)
                    : undefined;
                if (!pricelistEntry) {
                    console.warn(`ProductsReader: [ForceSync] Produkt ${entry.code} nemá záznam perPricelistPrices pro ceník ${pricelistId} -- VYNECHÁVÁM, zkusí se znovu příští synchronizací.`);
                    incompleteCodes.push(entry.code);
                    continue;
                }
                const basePrice = parseFloat(pricelistEntry.price?.price ?? "0") || 0;
                let actPrice: number | undefined = undefined;
                let productMaxDiscount: Decimal | undefined = undefined;
                const actionPriceVal = pricelistEntry.price?.actionPrice?.price;
                if (actionPriceVal !== null && actionPriceVal !== undefined) actPrice = parseFloat(actionPriceVal);
                const ratio = pricelistEntry.sales?.minPriceRatio;
                if (ratio !== null && ratio !== undefined) {
                    const ratioNum = parseFloat(ratio);
                    if (!isNaN(ratioNum) && ratioNum <= 1) productMaxDiscount = new Decimal(1).minus(new Decimal(ratioNum));
                }
                const vatRate = pricelistEntry.vatRate || detail.vatRate || "23.00";
                const includingVat = pricelistEntry.includingVat !== undefined ? pricelistEntry.includingVat : true;

                products.push({
                    code: variant?.code || detail.code || entry.code,
                    price: new Decimal(basePrice),
                    actionPrice: actPrice !== undefined ? new Decimal(actPrice) : undefined,
                    productMaxDiscount,
                    vatRate,
                    includingVat
                });
            }

            console.log(`ProductsReader: Staženo a zpracováno ${products.length} změněných produktů (${incompleteCodes.length} vynecháno pro chybějící ceníková data).`);
            return { products, incompleteCodes };

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
                productMaxDiscount,
                vatRate: item.vatRate || "23.00",
                includingVat: item.includingVat !== undefined ? item.includingVat : true
            };
        });

        console.log(`ProductsReader: Staženo ${products.length} produktů z ceníku ID ${pricelistId}.`);
        return { products, incompleteCodes: [] };
    }
}
