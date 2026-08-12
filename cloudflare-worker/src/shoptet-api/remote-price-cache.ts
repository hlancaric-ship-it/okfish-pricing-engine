import { ICacheProvider } from './cache-provider';

/**
 * Perzistentní náhrada za FileCacheProvider pro ostré běhy (run-real-sync.ts).
 * FileCacheProvider zapisuje na disk GitHub Actions runneru, který je při
 * KAŽDÉM běhu čerstvý stroj -- diff cache se tam nikdy nezachovala, takže
 * sync-orchestrator.ts posílal do Shoptet ceníku PATCH pro úplně všechny
 * produkty při každém běhu (potvrzeno živě, viz INCIDENTS.md INC-007).
 *
 * Data žijí v KV Workeru (endpoint /v1/price-cache/:pricelistId) -- jeden
 * JSON blob na ceník, čtený jednou při prvním dotazu na daný ceník a
 * zapisovaný jednou v commit() jen s produkty, které se skutečně změnily.
 * Zákaznické metody (setCustomerPricelist/getCustomerPricelist) sync-orchestrator
 * nikdy nevolá -- ponechány jako no-op kvůli splnění ICacheProvider rozhraní.
 */
export class RemotePriceCache implements ICacheProvider {
    // Ceník -> mapa kód->cena, jak ji vrátil Worker (načteno líně, jednou za ceník).
    private loadedPricelists: Map<number, Record<string, string>> = new Map();
    private loadingPricelists: Map<number, Promise<Record<string, string>>> = new Map();
    // Ceník -> jen produkty, u kterých setPrice() zjistil reálnou změnu -- tohle
    // (a jen tohle) se pošle v commit().
    private pendingUpdates: Map<number, Record<string, string>> = new Map();

    constructor(
        private readonly baseUrl: string,
        private readonly token: string
    ) {}

    private async loadPricelist(pricelistId: number): Promise<Record<string, string>> {
        if (this.loadedPricelists.has(pricelistId)) {
            return this.loadedPricelists.get(pricelistId)!;
        }
        if (this.loadingPricelists.has(pricelistId)) {
            return this.loadingPricelists.get(pricelistId)!;
        }

        const promise = (async () => {
            const res = await fetch(`${this.baseUrl}/v1/price-cache/${pricelistId}`, {
                headers: { Authorization: `Bearer ${this.token}` }
            });
            if (!res.ok) {
                throw new Error(`RemotePriceCache: načtení ceníku ${pricelistId} selhalo (${res.status})`);
            }
            const data = await res.json() as { prices: Record<string, string> };
            const prices = data.prices || {};
            this.loadedPricelists.set(pricelistId, prices);
            return prices;
        })();

        this.loadingPricelists.set(pricelistId, promise);
        return promise;
    }

    public async getPrice(pricelistId: number, productCode: string): Promise<string | null> {
        const prices = await this.loadPricelist(pricelistId);
        return prices[productCode] ?? null;
    }

    public async setPrice(pricelistId: number, productCode: string, price: string): Promise<void> {
        // Zapisuje se jen do lokální in-memory fronty na commit -- žádné síťové
        // volání tady, aby setPrice() (volané v těsné smyčce diffu) zůstalo rychlé.
        if (!this.pendingUpdates.has(pricelistId)) this.pendingUpdates.set(pricelistId, {});
        this.pendingUpdates.get(pricelistId)![productCode] = price;

        // Ať následné getPrice() ve stejném běhu (kdyby nastalo) vidí novou hodnotu
        // hned, ne až po commit().
        const loaded = this.loadedPricelists.get(pricelistId);
        if (loaded) loaded[productCode] = price;
    }

    public async setCustomerPricelist(): Promise<void> { /* nepoužito, viz komentář výše */ }
    public async getCustomerPricelist(): Promise<number | null> { return null; }

    public async commit(): Promise<void> {
        if (this.pendingUpdates.size === 0) return;

        for (const [pricelistId, updates] of this.pendingUpdates.entries()) {
            if (Object.keys(updates).length === 0) continue;
            const res = await fetch(`${this.baseUrl}/v1/price-cache/${pricelistId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
                body: JSON.stringify({ updates })
            });
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                // Vědomě NEswallowovat -- na rozdíl od starého FileCacheProvider
                // (který chybu zápisu na disk jen logoval a pokračoval) tady
                // selhání commitu znamená, že příští běh bude mít zastaralou
                // diff cache pro tenhle ceník a znovu pošle PATCH i pro už
                // zapsané ceny. Neškodné (Shoptet dostane idempotentní zápis
                // stejné hodnoty), ale mělo by to být vidět v logu, ne tiše
                // zmizet.
                throw new Error(`RemotePriceCache: commit ceníku ${pricelistId} selhal (${res.status}): ${body}`);
            }
        }
        this.pendingUpdates.clear();
    }
}
