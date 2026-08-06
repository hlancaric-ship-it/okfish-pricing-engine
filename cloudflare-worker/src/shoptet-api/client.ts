import { ShoptetRateLimiter } from './rate-limiter';

export const GlobalStats = {
    apiRequests: { GET: 0, PATCH: 0 } as Record<string, number>,
    httpResponses: {} as Record<number, number>,
    retries: {} as Record<number, number>,
    auditLogs: 0,
    rollbackSnapshots: 0,
    ordersLoaded: 0,
    turnoverCalculated: 0,
    // Diagnostic breadcrumb -- set by SyncOrchestrator at each major step, read by
    // the stats reporter (scripts/run-real-sync.ts). Lets the dashboard show WHICH
    // step a stuck run is stuck on, since raw GitHub Actions logs aren't readable
    // while a job is still in progress. Added 2026-08-06 after several runs stalled
    // with zero API requests and no way to tell where.
    phase: 'starting' as string
};

// Základní typy podle zjištění v API Discovery
export interface ShoptetPricelist {
    id: number;
    name: string;
}

export interface ShoptetPricelistItem {
    code: string;
    currencyCode: string;
    includingVat: boolean;
    vatRate: string;
    price: {
        price: string;
        commonPrice: string;
        buyPrice: string;
        priceRatio: string;
        actionPrice?: {
            price: string;
        };
    };
    sales: {
        minPriceRatio: string;
        loyaltyDiscount: boolean;
        volumeDiscount: boolean;
        quantityDiscount: boolean;
        discountCoupon: boolean;
    };
    prices?: {
        purchasePrice?: {
            price: string;
            vatRate: string;
            includingVat: boolean;
        };
    };
}

export interface ShoptetOrder {
    code: string;
    guid: string;
    changeTime: string;
    customerGuid?: string;
    paid: boolean;
    status: {
        id: number;
        name: string;
    };
    price: {
        withVat: string;
    };
}

export interface ShoptetCustomer {
    guid: string;
    changeTime: string;
    customerGroup?: {
        id: number;
        name: string;
    };
    priceList?: {
        id: number;
        name: string;
    };
    accounts?: { email: string }[];
}

export interface ShoptetChange {
    guid: string;
    changeType: 'edit' | 'delete';
    changeTime: string;
    code?: string; // Produkty a objednávky mívají kód, zákazníci většinou ne
}


export class ShoptetApiClient {
    private readonly baseUrl = 'https://api.myshoptet.com/api';
    private rateLimiter: ShoptetRateLimiter;

    constructor(
        private readonly token: string,
        rateLimiter?: ShoptetRateLimiter
    ) {
        if (!token) {
            throw new Error('Shoptet Private API Token chybí.');
        }
        this.rateLimiter = rateLimiter || new ShoptetRateLimiter();
    }



    private getHeaders(): HeadersInit {
        return {
            'Shoptet-Private-API-Token': this.token,
            'Content-Type': 'application/vnd.shoptet.v1.0'
        };
    }

    /**
     * Stáhne seznam všech dostupných ceníků (endpoint nepodporuje stránkování)
     */
    public async getPricelists(): Promise<ShoptetPricelist[]> {
        const url = `${this.baseUrl}/pricelists`;

        return this.rateLimiter.execute(
            async () => {
                GlobalStats.apiRequests.GET++;
                const res = await fetch(url, { headers: this.getHeaders() });
                GlobalStats.httpResponses[res.status] = (GlobalStats.httpResponses[res.status] || 0) + 1;
                return res;
            },
            async (res) => {
                const json = await res.json() as any;
                if (json.errors && json.errors.length > 0) {
                    throw new Error(`API chyba: ${JSON.stringify(json.errors)}`);
                }
                return json.data.pricelists as ShoptetPricelist[];
            }
        );
    }

    /**
     * Stáhne seznam všech položek ceníku (pouze helper)
     */
    public async getPricelistItems(pricelistId: number): Promise<ShoptetPricelistItem[]> {
        return this.fetchPaginated<ShoptetPricelistItem>(`/pricelists/${pricelistId}`, 'pricelist', 100);
    }

    /**
     * Stáhne všechny zákazníky se stránkováním.
     * Upozornění: Vrací pouze základní GUID, pro detail (CustomerGroup) je často nutné stáhnout detail, 
     * avšak Shoptet dokumentace uvádí, že detailní filtry mohou vrátit skupiny, takže to budeme brát 
     * přes custom iterátor pokud je to třeba.
     */
    public async getCustomers(maxPages?: number): Promise<ShoptetCustomer[]> {
        return this.fetchPaginated<ShoptetCustomer>('/customers', 'customers', 1000, maxPages);
    }

    /**
     * Získá detail zákazníka (hlavně kvůli customerGroup)
     */
    public async getCustomerDetail(guid: string): Promise<ShoptetCustomer> {
        const url = `${this.baseUrl}/customers/${guid}`;
        return this.rateLimiter.execute(
            async () => {
                GlobalStats.apiRequests.GET++;
                const res = await fetch(url, { headers: this.getHeaders() });
                GlobalStats.httpResponses[res.status] = (GlobalStats.httpResponses[res.status] || 0) + 1;
                return res;
            },
            async (res) => {
                const json = await res.json() as any;
                if (json.errors && json.errors.length > 0) throw new Error(`API chyba: ${JSON.stringify(json.errors)}`);
                return json.data.customer as ShoptetCustomer;
            }
        );
    }

    /**
     * Získá seznam zákaznických skupin z API.
     */
    public async getCustomerGroups(): Promise<any[]> {
        const url = `${this.baseUrl}/customers/groups`;
        return this.rateLimiter.execute(
            async () => {
                GlobalStats.apiRequests.GET++;
                const response = await fetch(url, { headers: this.getHeaders() });
                GlobalStats.httpResponses[response.status] = (GlobalStats.httpResponses[response.status] || 0) + 1;
                return response;
            },
            async (res) => {
                if (!res.ok) {
                    throw new Error(`Failed to fetch customer groups. Status: ${res.status}`);
                }
                const json = await res.json() as any;
                return Array.isArray(json) ? json : (json.data?.customerGroups || []);
            }
        );
    }

    /**
     * Získá detail produktu s informacemi o cenách
     */
    public async getProductDetail(guid: string): Promise<any> {
        const url = `${this.baseUrl}/products/${guid}?include=perPricelistPrices`;
        return this.rateLimiter.execute(
            async () => {
                GlobalStats.apiRequests.GET++;
                const res = await fetch(url, { headers: this.getHeaders() });
                GlobalStats.httpResponses[res.status] = (GlobalStats.httpResponses[res.status] || 0) + 1;
                return res;
            },
            async (res) => {
                const json = await res.json() as any;
                if (json.errors && json.errors.length > 0) {
                    if (res.status === 404) return null; // Může být smazaný
                    throw new Error(`API chyba: ${JSON.stringify(json.errors)}`);
                }
                return json.data.product;
            }
        );
    }

    /**
     * Inkrementální stahování objednávek (pokud je known from date)
     */
    public async getOrderChanges(from: string): Promise<ShoptetChange[]> {
        return this.fetchPaginated<ShoptetChange>(`/orders/changes?from=${encodeURIComponent(from)}`, 'changes', 1000);
    }

    /**
     * Inkrementální stahování změn produktů
     */
    public async getProductChanges(from: string): Promise<ShoptetChange[]> {
        return this.fetchPaginated<ShoptetChange>(`/products/changes?from=${encodeURIComponent(from)}`, 'changes', 1000);
    }

    /**
     * Inkrementální stahování změn zákazníků
     */
    public async getCustomerChanges(from: string): Promise<ShoptetChange[]> {
        return this.fetchPaginated<ShoptetChange>(`/customers/changes?from=${encodeURIComponent(from)}`, 'changes', 1000);
    }

    /**
     * Stáhne objednávky konkrétního zákazníka
     */
    public async getCustomerOrders(customerGuid: string): Promise<ShoptetOrder[]> {
        return this.fetchPaginated<ShoptetOrder>(`/orders?customerGuid=${encodeURIComponent(customerGuid)}`, 'orders', 1000);
    }

    /**
     * Stáhne objednávky, které byly změněny v daném časovém rozmezí
     */
    public async getOrdersByChangeTime(from: string, to?: string): Promise<ShoptetOrder[]> {
        let url = `/orders?changeTimeFrom=${encodeURIComponent(from)}`;
        if (to) {
            url += `&changeTimeTo=${encodeURIComponent(to)}`;
        }
        return this.fetchPaginated<ShoptetOrder>(url, 'orders', 1000);
    }

    /**
     * Plné stažení všech objednávek (Fallback - nemělo by se už používat pro běžný běh)
     */
    public async getAllOrders(maxPages?: number): Promise<ShoptetOrder[]> {
        return this.fetchPaginated<ShoptetOrder>('/orders', 'orders', 1000, maxPages);
    }

    /**
     * Stáhne všechny produkty pro konkrétní ceník
     */
    public async getPricelistProducts(pricelistId: number, maxPages?: number): Promise<any[]> {
        return this.fetchPaginated<any>(`/pricelists/${pricelistId}`, 'pricelist', 1000, maxPages);
    }

    /**
     * Obecná metoda pro procházení Shoptet paginace
     */
    private async fetchPaginated<T>(endpointPath: string, dataKey: string, itemsPerPage: number = 1000, maxPages?: number): Promise<T[]> {
        let page = 1;
        let allItems: T[] = [];
        let totalPages = 1;
        const separator = endpointPath.includes('?') ? '&' : '?';

        do {
            const url = `${this.baseUrl}${endpointPath}${separator}page=${page}&itemsPerPage=${itemsPerPage}`;

            const result = await this.rateLimiter.execute(
                async () => {
                    GlobalStats.apiRequests.GET++;
                    const res = await fetch(url, { headers: this.getHeaders() });
                    GlobalStats.httpResponses[res.status] = (GlobalStats.httpResponses[res.status] || 0) + 1;
                    return res;
                },
                async (res) => {
                    const json = await res.json() as any;
                    if (json.errors && json.errors.length > 0) {
                        throw new Error(`API chyba: ${JSON.stringify(json.errors)}`);
                    }
                    return json;
                }
            );

            // Shoptet API vrací např. result.data.pricelist.items, result.data.orders
            let itemsRaw: any = result.data;
            for (const key of dataKey.split('.')) {
                if (itemsRaw) {
                    itemsRaw = itemsRaw[key];
                }
            }
            const items = itemsRaw as T[];
            if (items && Array.isArray(items)) {
                allItems = allItems.concat(items);
            }

            if (result.data.paginator) {
                totalPages = result.data.paginator.pageCount;
            } else {
                totalPages = 1; // Pokud endpoint nemá stránkování (ale my víme, že tyto mají)
            }
            if (page % 50 === 0 || page === 1 || page === totalPages) {
                console.log(`[Paginator] Fetching ${endpointPath} - Stránka ${page} / ${totalPages}`);
            }
            page++;
            if (maxPages && page > maxPages) {
                console.log(`[Paginator] Dosažen nastavený limit maxPages = ${maxPages}. Ukončuji stahování.`);
                break;
            }
        } while (page <= totalPages);

        return allItems;
    }

    /**
     * Uloží dávku cen do ceníku (WRITE)
     */
    public async updatePricelistBatch(pricelistId: number, items: Array<{ code: string, price: string }>): Promise<{ requestId: string, response: string, timestamp: string, status: number, endpoint: string }> {
        const endpointPath = `/pricelists/${pricelistId}`;
        const url = `${this.baseUrl}${endpointPath}`;
        const body = {
            data: items.map(item => ({
                code: item.code,
                price: { price: item.price }
            }))
        };

        return await this.rateLimiter.execute(
            async () => {
                GlobalStats.apiRequests.PATCH++;
                const res = await fetch(url, {
                    method: 'PATCH',
                    headers: this.getHeaders(),
                    body: JSON.stringify(body)
                });
                GlobalStats.httpResponses[res.status] = (GlobalStats.httpResponses[res.status] || 0) + 1;
                return res;
            },
            async (res) => {
                const json = await res.json() as any;
                if (json.errors && json.errors.length > 0) {
                    throw new Error(`API chyba při zápisu ceníku ${pricelistId}: ${JSON.stringify(json.errors)}`);
                }
                const reqId = res.headers.get('x-request-id') || res.headers.get('cf-ray') || 'N/A';
                return {
                    requestId: reqId,
                    response: JSON.stringify(json.data || {}),
                    timestamp: new Date().toISOString(),
                    status: res.status,
                    endpoint: endpointPath
                };
            }
        );
    }

    /**
     * Uloží dávku sales polí (discountCoupon, minPriceRatio) do ceníku (WRITE).
     * Samostatná metoda od updatePricelistBatch — posílá jen `sales`, ne `price`,
     * takže cenová pole zůstávají nedotčená (viz Shoptet docs: "Send only fields
     * you want to change, the others will stay untouched").
     */
    public async updatePricelistSalesBatch(
        pricelistId: number,
        items: Array<{ code: string, discountCoupon: boolean, minPriceRatio: string }>
    ): Promise<{ requestId: string, response: string, timestamp: string, status: number, endpoint: string }> {
        const endpointPath = `/pricelists/${pricelistId}`;
        const url = `${this.baseUrl}${endpointPath}`;
        const body = {
            data: items.map(item => ({
                code: item.code,
                sales: {
                    discountCoupon: item.discountCoupon,
                    minPriceRatio: item.minPriceRatio
                }
            }))
        };

        return await this.rateLimiter.execute(
            async () => {
                GlobalStats.apiRequests.PATCH++;
                const res = await fetch(url, {
                    method: 'PATCH',
                    headers: this.getHeaders(),
                    body: JSON.stringify(body)
                });
                GlobalStats.httpResponses[res.status] = (GlobalStats.httpResponses[res.status] || 0) + 1;
                return res;
            },
            async (res) => {
                const json = await res.json() as any;
                if (json.errors && json.errors.length > 0) {
                    throw new Error(`API chyba při zápisu sales polí ceníku ${pricelistId}: ${JSON.stringify(json.errors)}`);
                }
                const reqId = res.headers.get('x-request-id') || res.headers.get('cf-ray') || 'N/A';
                return {
                    requestId: reqId,
                    response: JSON.stringify(json.data || {}),
                    timestamp: new Date().toISOString(),
                    status: res.status,
                    endpoint: endpointPath
                };
            }
        );
    }

    /**
     * Nastaví, zda lze variantu objednat i do záporného skladu (negativeStockAllowed).
     * PATCH /api/products/code/{code} — samostatná metoda, nezávislá na cenových
     * ani sales zápisech výše.
     */
    public async updateNegativeStockAllowed(
        code: string,
        allowed: boolean
    ): Promise<{ requestId: string, status: number, endpoint: string }> {
        const endpointPath = `/products/code/${encodeURIComponent(code)}`;
        const url = `${this.baseUrl}${endpointPath}`;
        const body = {
            data: {
                variants: [
                    { code, negativeStockAllowed: allowed }
                ]
            }
        };

        return await this.rateLimiter.execute(
            async () => {
                GlobalStats.apiRequests.PATCH++;
                const res = await fetch(url, {
                    method: 'PATCH',
                    headers: this.getHeaders(),
                    body: JSON.stringify(body)
                });
                GlobalStats.httpResponses[res.status] = (GlobalStats.httpResponses[res.status] || 0) + 1;
                return res;
            },
            async (res) => {
                const json = await res.json() as any;
                if (json.errors && json.errors.length > 0) {
                    throw new Error(`API chyba při zápisu negativeStockAllowed pro ${code}: ${JSON.stringify(json.errors)}`);
                }
                const reqId = res.headers.get('x-request-id') || res.headers.get('cf-ray') || 'N/A';
                return { requestId: reqId, status: res.status, endpoint: endpointPath };
            }
        );
    }

    /**
     * Stáhne seznam všech dostupností (Nastavení -> Produkty -> Dostupnosti),
     * včetně systémových (Skladem, Na dotaz, Nedostupné, ...).
     */
    public async getAvailabilities(): Promise<{ id: number; name: string; system: boolean }[]> {
        const url = `${this.baseUrl}/products/availabilities`;
        return await this.rateLimiter.execute(
            async () => {
                GlobalStats.apiRequests.GET++;
                const res = await fetch(url, { headers: this.getHeaders() });
                GlobalStats.httpResponses[res.status] = (GlobalStats.httpResponses[res.status] || 0) + 1;
                return res;
            },
            async (res) => {
                const json = await res.json() as any;
                if (json.errors && json.errors.length > 0) {
                    throw new Error(`API chyba při čtení dostupností: ${JSON.stringify(json.errors)}`);
                }
                return json.data.availabilities as { id: number; name: string; system: boolean }[];
            }
        );
    }

    /**
     * Nastaví zároveň negativeStockAllowed a availabilityWhenSoldOutId (dostupnost
     * zobrazená zákazníkovi, když je produkt vyprodaný) — stejný PATCH endpoint a
     * tělo jako updateNegativeStockAllowed výše, jen s dalším polem navíc.
     */
    public async updateStockoutBehavior(
        code: string,
        allowed: boolean,
        availabilityWhenSoldOutId: number
    ): Promise<{ requestId: string, status: number, endpoint: string }> {
        const endpointPath = `/products/code/${encodeURIComponent(code)}`;
        const url = `${this.baseUrl}${endpointPath}`;
        const body = {
            data: {
                variants: [
                    { code, negativeStockAllowed: allowed, availabilityWhenSoldOutId }
                ]
            }
        };

        return await this.rateLimiter.execute(
            async () => {
                GlobalStats.apiRequests.PATCH++;
                const res = await fetch(url, {
                    method: 'PATCH',
                    headers: this.getHeaders(),
                    body: JSON.stringify(body)
                });
                GlobalStats.httpResponses[res.status] = (GlobalStats.httpResponses[res.status] || 0) + 1;
                return res;
            },
            async (res) => {
                const json = await res.json() as any;
                if (json.errors && json.errors.length > 0) {
                    throw new Error(`API chyba při zápisu stockout chování pro ${code}: ${JSON.stringify(json.errors)}`);
                }
                const reqId = res.headers.get('x-request-id') || res.headers.get('cf-ray') || 'N/A';
                return { requestId: reqId, status: res.status, endpoint: endpointPath };
            }
        );
    }

    /**
     * Aktualizuje zařazení zákazníka do ceníku a zákaznické skupiny.
     * @param guid GUID zákazníka
     * @param pricelistId ID nového ceníku
     * @param customerGroupCode Kód zákaznické skupiny (volitelný)
     */
    public async updateCustomerGroup(guid: string, pricelistId: number, customerGroupCode?: string): Promise<{ requestId: string, response: string, timestamp: string, status: number, endpoint: string }> {
        const endpointPath = `/customers/${guid}`;
        const url = `${this.baseUrl}${endpointPath}`;

        const dataPayload: any = {
            pricelistId: pricelistId
        };

        if (customerGroupCode) {
            dataPayload.customerGroupCode = customerGroupCode;
        }

        const body = {
            data: dataPayload
        };

        return await this.rateLimiter.execute(
            async () => {
                GlobalStats.apiRequests.PATCH++;
                const res = await fetch(url, {
                    method: 'PATCH',
                    headers: this.getHeaders(),
                    body: JSON.stringify(body)
                });
                GlobalStats.httpResponses[res.status] = (GlobalStats.httpResponses[res.status] || 0) + 1;
                return res;
            },
            async (res) => {
                const json = await res.json() as any;
                if (json.errors && json.errors.length > 0) {
                    throw new Error(`API chyba při úpravě zákazníka ${guid}: ${JSON.stringify(json.errors)}`);
                }
                const reqId = res.headers.get('x-request-id') || res.headers.get('cf-ray') || 'N/A';
                return {
                    requestId: reqId,
                    response: JSON.stringify(json.data || {}),
                    timestamp: new Date().toISOString(),
                    status: res.status,
                    endpoint: endpointPath
                };
            }
        );
    }
}
