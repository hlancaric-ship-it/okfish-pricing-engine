import { ShoptetApiClient } from './client';
import Decimal from 'decimal.js';

export interface ShoptetProduct {
    code: string;
    price: Decimal;
    actionPrice?: Decimal;
    productMaxDiscount?: Decimal;
}

export class ProductsReader {
    constructor(private readonly apiClient: ShoptetApiClient) {}

    /**
     * Stáhne produkty (plně nebo inkrementálně, pokud je k dispozici lastSync).
     * `incompleteCodes` obsahuje kódy produktů, které SE ZMĚNILY, ale Shoptet pro ně
     * ještě nevrátil perPricelistPrices na základním ceníku (typicky produkt založený
     * jen pár minut/hodin předtím — propagace do ceníku má u Shoptetu zpoždění).
     * Tyto produkty se NESMÍ zapsat s vyfabrikovanou basePrice=0 (viz INCIDENT
     * 2026-08-12: 99459 a 103525 přidané Yopni skončily s nulovou/nedopočítanou cenou
     * na wholesale ceníku a nikdo si toho nevšiml, protože run doběhl jako "success").
     * Orchestrátor musí tyto kódy zohlednit a NEPOSOUVAT lastSync dál, dokud se
     * nedopočítají — jinak zmizí z dalšího inkrementálního okna navždy.
     */
    public async fetchProducts(pricelistId: number, maxPages?: number, lastSync?: string | null): Promise<{ products: ShoptetProduct[]; incompleteCodes: string[] }> {
        if (lastSync) {
            console.log(`ProductsReader: INKREMENTÁLNÍ REŽIM - Hledám změněné produkty od ${lastSync}...`);
            const changes = await this.apiClient.getProductChanges(lastSync);

            if (changes.length === 0) {
                console.log(`ProductsReader: Žádné produkty nebyly od ${lastSync} změněny.`);
                return { products: [], incompleteCodes: [] }; // Orchestrátor podle toho vynechá pricing engine
            }

            console.log(`ProductsReader: Nalezeno ${changes.length} změn produktů. Stahuji detaily (s ohledem na rate limity)...`);
            const products: ShoptetProduct[] = [];
            const incompleteCodes: string[] = [];

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
                // `pricelistId`.
                const pricelistEntry = Array.isArray(detail.perPricelistPrices)
                    ? detail.perPricelistPrices.find((p: any) => p.pricelistId === pricelistId)
                    : undefined;

                const code = detail.code || change.code || change.guid;

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

                products.push({
                    code,
                    price: new Decimal(basePrice),
                    actionPrice: actPrice !== undefined ? new Decimal(actPrice) : undefined,
                    productMaxDiscount
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
                productMaxDiscount
            };
        });

        console.log(`ProductsReader: Staženo ${products.length} produktů z ceníku ID ${pricelistId}.`);
        return { products, incompleteCodes: [] };
    }
}
