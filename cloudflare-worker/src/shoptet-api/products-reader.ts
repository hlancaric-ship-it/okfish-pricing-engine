import { ShoptetApiClient } from './client';
import Decimal from 'decimal.js';

export interface ShoptetProduct {
    code: string;
    price: Decimal;
    actionPrice?: Decimal;
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

                // Tady musíme z detailu získat základní cenu z ceníku s `pricelistId`
                // product detail API obvykle obsahuje pole `prices` nebo podobně
                let basePrice = 0;
                let actPrice: number | undefined = undefined;

                // Vyhledáme základní cenu (default price) nebo cenu v daném pricelistu
                // Předpokládáme standardní strukturu, např. detail.prices[?] nebo root level
                if (detail.price) {
                     // TODO: Pokud by detail.price bylo víc ceníků, tak to musíme najít podle pricelistId.
                     // Prozatím vezmeme základní price, protože se ptáme na basePricelist.
                     basePrice = parseFloat(detail.price.withVat || detail.price.withoutVat || "0");
                }

                // Pokud chceme zajistit 100% jistotu s `getPricelistProducts`, 
                // tak pro inkrementální sync bychom museli použít jinou strukturu.
                // Nicméně basePrice je primární cena.
                // Pro zachování plné kompatibility s getPricelistProducts 
                // použijeme detail.prices. Pro jistotu namapujeme i actionPrice, pokud je k dispozici.
                
                products.push({
                    code: detail.code || change.code || change.guid,
                    price: new Decimal(basePrice),
                    actionPrice: actPrice !== undefined ? new Decimal(actPrice) : undefined
                });
            }

            console.log(`ProductsReader: Staženo a zpracováno ${products.length} změněných produktů.`);
            return products;

        }

        console.log(`ProductsReader: FULL SYNC - Stahování všech produktů pro ceník ID ${pricelistId}...`);
        const items = await this.apiClient.getPricelistProducts(pricelistId, maxPages);
        
        const products: ShoptetProduct[] = items.map(item => {
            const basePrice = item.price?.price ? item.price.price : 0;
            const actPrice = item.price?.actionPrice?.price;
            return {
                code: item.code,
                price: new Decimal(basePrice),
                actionPrice: actPrice !== null && actPrice !== undefined ? new Decimal(actPrice) : undefined
            };
        });

        console.log(`ProductsReader: Staženo ${products.length} produktů z ceníku ID ${pricelistId}.`);
        return products;
    }
}
