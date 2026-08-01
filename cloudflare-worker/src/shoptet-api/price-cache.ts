import Decimal from 'decimal.js';

/**
 * Interface pro cachování posledních známých cen.
 * V Cloudflare Worker prostředí bude implementováno přes KV storage.
 * Pro lokální E2E test využijeme File-based / Memory cache.
 */
export interface PriceCache {
    /**
     * Získá poslední známou cenu produktu v daném ceníku.
     */
    getPrice(pricelistId: number, productCode: string): Promise<Decimal | null>;
    
    /**
     * Uloží novou cenu do cache. (Typicky voláno až po úspěšném zápisu do API)
     */
    setPrice(pricelistId: number, productCode: string, price: Decimal): Promise<void>;
    
    /**
     * Uloží více cen najednou (bulk operation).
     */
    setPricesBatch(pricelistId: number, updates: { code: string, price: Decimal }[]): Promise<void>;
}

// Jednoduchá In-Memory implementace pro lokální testování E2E
export class MemoryPriceCache implements PriceCache {
    // Mapujeme: "pricelistId:productCode" -> "cena"
    private store: Map<string, string> = new Map();

    async getPrice(pricelistId: number, productCode: string): Promise<Decimal | null> {
        const val = this.store.get(`${pricelistId}:${productCode}`);
        return val ? new Decimal(val) : null;
    }

    async setPrice(pricelistId: number, productCode: string, price: Decimal): Promise<void> {
        this.store.set(`${pricelistId}:${productCode}`, price.toString());
    }

    async setPricesBatch(pricelistId: number, updates: { code: string; price: Decimal; }[]): Promise<void> {
        for (const u of updates) {
            this.store.set(`${pricelistId}:${u.code}`, u.price.toString());
        }
    }
}
