import { ShoptetApiClient, GlobalStats } from './client';
import { ICustomerCache } from './customer-cache';
import * as fs from 'fs';
import * as path from 'path';

export interface CustomerDiff {
    customerGuid: string;
    customerName: string;
    oldTier: string | null;
    newTier: string;
    oldPricelistId: number | null;
    newPricelistId: number;
}

export interface CustomerWriterOptions {
    dryRun?: boolean;
    pricelistNameMap: Record<string, number>; // e.g. { "ZR10": 27, "ZR25": 29 }
    customerGroupMap?: Record<string, string>; // e.g. { "ZR10": "zr10" }
    customerCache?: ICustomerCache; // Zápis do KV
}

export class CustomerWriter {
    constructor(
        private readonly apiClient: ShoptetApiClient,
        private readonly options: CustomerWriterOptions
    ) {}

    /**
     * Zpracuje diff a (pokud není dryRun) odešle změny do API.
     * Vrací statistiky zápisu.
     */
    public async processDiff(diffs: CustomerDiff[]) {
        const stats = {
            total: diffs.length,
            processed: 0,
            failed: 0,
            skipped: 0,
            dryRun: this.options.dryRun === true,
            errors: [] as string[]
        };

        if (diffs.length === 0) {
            console.log('CustomerWriter: Žádné změny u zákazníků k zápisu.');
            return stats;
        }

        console.log(`CustomerWriter: Nalezeno ${diffs.length} zákazníků s novým věrnostním tierem. (DryRun: ${stats.dryRun})`);

        for (const diff of diffs) {
            // Kontrola, zda nová úroveň (tier) existuje v mapě ceníků
            if (!this.options.pricelistNameMap[diff.newTier]) {
                const errorMsg = `Nenalezena shoda v pricelistNameMap pro ceník '${diff.newTier}'. Zákazník ${diff.customerGuid} přeskočen.`;
                console.error(`[ERROR] ${errorMsg}`);
                stats.errors.push(errorMsg);
                stats.failed++;
                continue;
            }

            diff.newPricelistId = this.options.pricelistNameMap[diff.newTier];

            if (diff.oldPricelistId === diff.newPricelistId) {
                stats.skipped++;
                continue; // Identické ID, přeskočíme
            }

            console.log(`[DIFF] Zákazník: ${diff.customerName} (${diff.customerGuid}) | Ceník ID: ${diff.oldPricelistId} -> ${diff.newPricelistId} (${diff.oldTier || 'None'} -> ${diff.newTier})`);
            
            // Tvorba Snapshotu před prvním zápisem v tomto běhu
            if (!stats.dryRun && stats.processed === 0 && diffs.length > 0) {
                try {
                    const snapshotData = diffs.map(d => ({
                        customerGuid: d.customerGuid,
                        originalTier: d.oldTier,
                        originalPricelistId: d.oldPricelistId
                    }));
                    const snapshotDir = path.resolve('./.snapshots');
                    if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });
                    const snapshotPath = path.join(snapshotDir, `customer_rollback_${Date.now()}.json`);
                    fs.writeFileSync(snapshotPath, JSON.stringify(snapshotData, null, 2), 'utf-8');
                    GlobalStats.rollbackSnapshots++;
                    console.log(`[SNAPSHOT] Vytvořen rollback snapshot pro zákazníky: ${snapshotPath}`);
                } catch (e) {
                    console.warn(`[SNAPSHOT] Varování: Nepodařilo se vytvořit snapshot: ${e}`);
                }
            }

            if (!stats.dryRun) {
                try {
                    const reqStart = Date.now();
                    const groupCode = this.options.customerGroupMap ? this.options.customerGroupMap[diff.newTier] : undefined;
                    const apiResult = await this.apiClient.updateCustomerGroup(diff.customerGuid, diff.newPricelistId, groupCode);
                    const duration = Date.now() - reqStart;
                    stats.processed++;
                    
                    // Zápis do KV přes customerCache
                    if (this.options.customerCache) {
                        try {
                            const detail = await this.apiClient.getCustomerDetail(diff.customerGuid);
                            const email = detail?.accounts?.[0]?.email;
                            if (email) {
                                // Extrakce procenta slevy z názvu tieru, např. 'ZR4' -> 4
                                const match = diff.newTier.match(/ZR(\d+)/i);
                                const discount = match ? parseInt(match[1], 10) : 0;
                                await this.options.customerCache.setCustomerDiscount(email, discount);
                                console.log(`[KV CACHE] Uložena sleva ${discount}% pro zákazníka ${email}`);
                            } else {
                                console.warn(`[KV CACHE] Zákazník ${diff.customerGuid} nemá e-mail, nelze zapsat do KV.`);
                            }
                        } catch (e: any) {
                            console.error(`[ERROR] Chyba při zápisu zákazníka ${diff.customerGuid} do KV:`, e.message);
                        }
                    }

                    // Přidání požadovaného Audit Logu
                    const oldTierLog = diff.oldTier || 'N/A';
                    GlobalStats.auditLogs++;
                    console.log(`[AUDIT LOG] timestamp: ${apiResult.timestamp} | entity: Customer | id: ${diff.customerGuid} | endpoint: ${apiResult.endpoint} | requestId: ${apiResult.requestId} | HTTP status: ${apiResult.status} | duration: ${duration}ms | attempt: 1 | oldValue: ${oldTierLog} | newValue: ${diff.newTier}`);
                    
                } catch (err: any) {
                    console.error(`[ERROR] Zápis zákazníka ${diff.customerGuid} selhal:`, err.message);
                    stats.errors.push(`Customer ${diff.customerGuid}: ${err.message}`);
                    stats.failed++;
                }
            } else {
                // V dryRun pouze simulujeme úspěšný zápis
                stats.processed++;
            }
        }

        console.log(`CustomerWriter dokončen. Zpracováno: ${stats.processed}, Přeskočeno: ${stats.skipped}, Selhalo: ${stats.failed}`);
        return stats;
    }
}
