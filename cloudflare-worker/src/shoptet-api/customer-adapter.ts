import { ShoptetApiClient, ShoptetCustomer, ShoptetOrder, GlobalStats } from './client';
import Decimal from 'decimal.js';

// Simulovaný existující algoritmus, který se "nesmí změnit" (zkopírováno z cli/customers-xlsx.ts)
type CustomerTier = "ZR4" | "ZR6" | "ZR8" | "ZR10" | "ZR12" | "ZR14" | "ZR16" | "ZR18" | "ZR20" | "ZR25";

function determineTier(totalOrderValue: number): CustomerTier | undefined {
    if (totalOrderValue >= 10000) return "ZR25";
    if (totalOrderValue >= 7000) return "ZR20";
    if (totalOrderValue >= 5000) return "ZR18";
    if (totalOrderValue >= 2000) return "ZR16";
    if (totalOrderValue >= 1000) return "ZR14";
    if (totalOrderValue >= 700) return "ZR12";
    if (totalOrderValue >= 500) return "ZR10";
    if (totalOrderValue >= 300) return "ZR8";
    if (totalOrderValue >= 100) return "ZR6";
    return "ZR4"; // 0 - 99.99
}

export interface CustomerDiff {
    customerGuid: string;
    totalSpend: number;
    oldTier: string | null;
    newTier: CustomerTier;
    changed: boolean;
    /** Needed so a full sync can repopulate the KV customer-discount cache for
     *  EVERY customer, not just the ones whose tier changed — see sync-orchestrator.ts. */
    email: string | null;
}

export class CustomerAdapter {
    constructor(private readonly apiClient: ShoptetApiClient) {}

    /**
     * Zpracování zákazníků s podporou inkrementální synchronizace
     */
    public async processCustomers(maxPages?: number, lastSync?: string | null, syncStartedAt?: string): Promise<CustomerDiff[]> {
        const customerSpendMap = new Map<string, Decimal>();
        let affectedCustomerGuids = new Set<string>();

        let orders: ShoptetOrder[] = [];
        let baseCustomers: ShoptetCustomer[] = [];

        if (lastSync && syncStartedAt) {
            console.log(`[CustomerAdapter] INKREMENTÁLNÍ REŽIM - Hledám změněné zákazníky od ${lastSync} do ${syncStartedAt}...`);
            
            const customerChanges = await this.apiClient.getCustomerChanges(lastSync);
            for (const c of customerChanges) affectedCustomerGuids.add(c.guid);
            
            // Preferovaná varianta (bod 2): Získat rovnou změněné objednávky včetně detailu
            console.log(`[CustomerAdapter] Stahuji změněné objednávky napřímo z /api/orders...`);
            const changedOrders = await this.apiClient.getOrdersByChangeTime(lastSync, syncStartedAt);
            
            for (const o of changedOrders) {
                if (o.customerGuid) {
                    affectedCustomerGuids.add(o.customerGuid);
                }
            }
            
            console.log(`[CustomerAdapter] Po spojení máme ${affectedCustomerGuids.size} dotčených zákazníků k přepočtu.`);
            
            if (affectedCustomerGuids.size === 0) {
                console.log(`[CustomerAdapter] Žádné změny u zákazníků ani objednávek od ${lastSync}.`);
                return [];
            }
            
            console.log('[CustomerAdapter] Stahuji celoživotní historii objednávek POUZE pro dotčené zákazníky (přepočet z nuly)...');
            // Stáhneme celoživotní historii POUZE pro tyto zákazníky (bod 4 a 5)
            for (const guid of affectedCustomerGuids) {
                const customerOrders = await this.apiClient.getCustomerOrders(guid);
                orders.push(...customerOrders);
            }
            
        } else {
             console.log('[CustomerAdapter] FULL SYNC - Stahuji všechny objednávky...');
             orders = await this.apiClient.getAllOrders(maxPages);
        }
        GlobalStats.ordersLoaded = orders.length;



        console.log(`[CustomerAdapter] Zpracovávám ${orders.length} objednávek...`);
        for (const order of orders) {
            // Logika původního Shoptet exportu: Dokončená (Vybavená = -3) nebo Zaplacená (markAsPaid)
            // Zde se spoléháme na přesné podmínky, které určil Shoptet (dle Discovery Reportu)
            //
            // Výjimka (potvrzeno klientem 2026-08-04): objednávky se stavem
            // "Navýšenie bodov" jsou čistě interní ruční navýšení obratu
            // (typ "Doplnenie bodov ZR"), vytvářené v adminu bez skutečné
            // platby přes bránu — u nich se platba nikdy nepotvrdí, protože
            // žádná neproběhla. Počítají se do obratu bez ohledu na `paid`.
            const isManualTurnoverTopUp = /navýšenie bodov/i.test(order.status.name ?? '');
            const isCompleted = order.status.id === -3 || order.paid || isManualTurnoverTopUp;
            const isCancelled = order.status.id === -4;

            if (isCompleted && !isCancelled && order.customerGuid) {
                const currentSpend = customerSpendMap.get(order.customerGuid) || new Decimal(0);
                const orderPrice = new Decimal(order.price.withVat || 0);
                customerSpendMap.set(order.customerGuid, currentSpend.plus(orderPrice));
                GlobalStats.turnoverCalculated += orderPrice.toNumber();
            }
        }

        console.log('[CustomerAdapter] Stahuji detaily zákazníků pro zjištění aktuální skupiny...');
        if (!lastSync) {
            baseCustomers = await this.apiClient.getCustomers(maxPages);
        } else {
            // Jen ti dotčení
            baseCustomers = Array.from(affectedCustomerGuids).map(guid => ({ guid, changeTime: '' }));
        }

        const diffs: CustomerDiff[] = [];

        // Zpracování zákazníků získáme jejich detaily
        // (zde v ukázce stáhneme detail postupně, v produkci použít dávky / concurrency)
        let processed = 0;
        for (const baseCustomer of baseCustomers) {
            processed++;
            if (processed % 100 === 0) {
                console.log(`[CustomerAdapter] Zpracováno zákazníků: ${processed}/${baseCustomers.length}`);
            }

            const totalSpend = customerSpendMap.get(baseCustomer.guid)?.toNumber() || 0;
            const newTier = determineTier(totalSpend);
            
            if (!newTier) continue;

            // A customer who placed an order in the sync window can still fail to
            // resolve here (e.g. deleted/GDPR-erased between the order and this sync
            // run — a real 404 seen in production). Letting that throw would abort
            // the ENTIRE hourly sync (all other customers' tier updates, all product
            // price updates) over one unresolvable customer. Skip just this one and
            // keep going instead — same "isolate the failure" principle already used
            // for batch writes elsewhere in this pipeline.
            let detail;
            try {
                detail = await this.apiClient.getCustomerDetail(baseCustomer.guid);
            } catch (error: any) {
                console.warn(`[CustomerAdapter] Přeskakuji zákazníka ${baseCustomer.guid} — detail se nepodařilo načíst: ${error.message}`);
                continue;
            }
            const oldTier = detail.customerGroup?.name || null;
            const email = detail.accounts?.[0]?.email || null;

            diffs.push({
                customerGuid: baseCustomer.guid,
                totalSpend,
                oldTier,
                newTier,
                changed: oldTier !== newTier,
                email
            });
        }

        return diffs;
    }
}
