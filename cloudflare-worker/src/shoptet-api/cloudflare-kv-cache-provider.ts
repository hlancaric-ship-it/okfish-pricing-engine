import { ICacheProvider } from './cache-provider';

/**
 * Cloudflare KV binding rozhraní.
 * Tuto strukturu předpokládáme v environmentu (např. env.SHOPTET_CACHE).
 */
export interface KVNamespace {
    get(key: string, type?: 'text' | 'json' | 'arrayBuffer' | 'stream'): Promise<string | any | null>;
    put(key: string, value: string | ReadableStream | ArrayBuffer, options?: { expiration?: number, expirationTtl?: number }): Promise<void>;
    delete(key: string): Promise<void>;
}

/**
 * Produkční Cloudflare KV Cache Provider.
 * Pracuje na principu read-through / write-through pro maximální rychlost,
 * ale ukládá data trvale do Cloudflare KV storage.
 */
export class CloudflareKVCacheProvider implements ICacheProvider {
    // Pro minimalizaci KV GET požadavků si udržujeme in-memory mapu během jednoho běhu (životnosti workeru)
    private localPriceMap: Map<string, string> = new Map();
    private localCustomerMap: Map<string, number> = new Map();
    
    // Fronta na uložení, abychom mohli dávkovat operace při commitu (pokud by to API dovolovalo, jinak u KV to zapisujeme jednotlivě nebo simulovaným bulkiem přes Promise.all)
    private pendingPriceWrites: Map<string, string> = new Map();
    private pendingCustomerWrites: Map<string, number> = new Map();

    constructor(private readonly kv: KVNamespace) {}

    private getPriceKey(pricelistId: number, productCode: string): string {
        return `price:${pricelistId}:${productCode}`;
    }

    private getCustomerKey(customerGuid: string): string {
        return `customer:${customerGuid}`;
    }

    public async setPrice(pricelistId: number, productCode: string, price: string): Promise<void> {
        const key = this.getPriceKey(pricelistId, productCode);
        this.localPriceMap.set(key, price);
        this.pendingPriceWrites.set(key, price);
    }

    public async getPrice(pricelistId: number, productCode: string): Promise<string | null> {
        const key = this.getPriceKey(pricelistId, productCode);
        
        if (this.localPriceMap.has(key)) {
            return this.localPriceMap.get(key) || null;
        }

        // Pokud není v lokální paměti, zkusíme stáhnout z KV
        try {
            const value = await this.kv.get(key);
            if (value !== null) {
                this.localPriceMap.set(key, value);
                return value;
            }
        } catch (e) {
            console.error(`[KVCache] Nelze načíst cenu z KV pro klíč ${key}:`, e);
        }

        return null;
    }

    public async setCustomerPricelist(customerGuid: string, pricelistId: number): Promise<void> {
        const key = this.getCustomerKey(customerGuid);
        this.localCustomerMap.set(key, pricelistId);
        this.pendingCustomerWrites.set(key, pricelistId);
    }

    public async getCustomerPricelist(customerGuid: string): Promise<number | null> {
        const key = this.getCustomerKey(customerGuid);

        if (this.localCustomerMap.has(key)) {
            return this.localCustomerMap.get(key) || null;
        }

        try {
            const value = await this.kv.get(key);
            if (value !== null) {
                const parsed = parseInt(value, 10);
                this.localCustomerMap.set(key, parsed);
                return parsed;
            }
        } catch (e) {
            console.error(`[KVCache] Nelze načíst zákazníka z KV pro klíč ${key}:`, e);
        }

        return null;
    }

    /**
     * Zápis všech změn do KV najednou.
     * U Cloudflare KV je potřeba dát pozor na limit 1000 PUT požadavků za sekundu, což by nám ale v naší architekturě (maximálně 10 requestů na batch do API) nemělo dělat potíže, přesto je doporučeno to posílat v dávkách.
     */
    public async commit(): Promise<void> {
        console.log(`[KVCache] Committing ${this.pendingPriceWrites.size} prices and ${this.pendingCustomerWrites.size} customers to KV...`);
        
        const promises: Promise<void>[] = [];

        for (const [key, price] of this.pendingPriceWrites.entries()) {
            promises.push(this.kv.put(key, price));
        }
        this.pendingPriceWrites.clear();

        for (const [key, pricelistId] of this.pendingCustomerWrites.entries()) {
            promises.push(this.kv.put(key, pricelistId.toString()));
        }
        this.pendingCustomerWrites.clear();

        try {
            // Paralelní zpracování KV zápisů v dávkách po 50
            const batchSize = 50;
            for (let i = 0; i < promises.length; i += batchSize) {
                await Promise.all(promises.slice(i, i + batchSize));
            }
            console.log('[KVCache] Commit do Cloudflare KV úspěšně dokončen.');
        } catch (e) {
            console.error('[KVCache] Chyba při hromadném zápisu do KV:', e);
        }
    }
}
