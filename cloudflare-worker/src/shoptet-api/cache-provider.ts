import * as fs from 'fs';
import * as path from 'path';

/**
 * Interface pro Cache Provider, aby bylo možné jednoduše vyměnit
 * lokální file cache (pro E2E) za Cloudflare KV.
 */
export interface ICacheProvider {
    /** Uloží cenu produktu (kód) pod daným ID ceníku */
    setPrice(pricelistId: number, productCode: string, price: string): Promise<void>;
    
    /** Získá cenu produktu v daném ceníku */
    getPrice(pricelistId: number, productCode: string): Promise<string | null>;
    
    /** Uloží zařazení zákazníka (GUID) do ceníku (Věrnostního Tieru) */
    setCustomerPricelist(customerGuid: string, pricelistId: number): Promise<void>;
    
    /** Získá ID ceníku (Věrnostního Tieru) zákazníka */
    getCustomerPricelist(customerGuid: string): Promise<number | null>;

    /** Uloží veškeré probíhající změny na disk / do KV (pro hromadné operace) */
    commit(): Promise<void>;
}

export class FileCacheProvider implements ICacheProvider {
    private cache: {
        prices: Record<number, Record<string, string>>;
        customers: Record<string, number>;
    };
    private filePath: string;

    constructor(filePath: string = './.cache/state.json') {
        this.filePath = path.resolve(filePath);
        this.cache = { prices: {}, customers: {} };
        this.load();
    }

    private load() {
        try {
            if (fs.existsSync(this.filePath)) {
                const data = fs.readFileSync(this.filePath, 'utf-8');
                this.cache = JSON.parse(data);
            }
        } catch (e) {
            console.warn(`[FileCache] Nelze načíst cache: ${e}`);
        }
    }

    public async commit(): Promise<void> {
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), 'utf-8');
        } catch (e) {
            console.error(`[FileCache] Nelze uložit cache: ${e}`);
        }
    }

    public async setPrice(pricelistId: number, productCode: string, price: string): Promise<void> {
        if (!this.cache.prices[pricelistId]) {
            this.cache.prices[pricelistId] = {};
        }
        this.cache.prices[pricelistId][productCode] = price;
    }

    public async getPrice(pricelistId: number, productCode: string): Promise<string | null> {
        if (this.cache.prices[pricelistId] && this.cache.prices[pricelistId][productCode]) {
            return this.cache.prices[pricelistId][productCode];
        }
        return null;
    }

    public async setCustomerPricelist(customerGuid: string, pricelistId: number): Promise<void> {
        this.cache.customers[customerGuid] = pricelistId;
    }

    public async getCustomerPricelist(customerGuid: string): Promise<number | null> {
        return this.cache.customers[customerGuid] || null;
    }
}
