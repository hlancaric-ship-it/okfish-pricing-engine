import { ShoptetApiClient, GlobalStats } from './client';
import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';

export interface PricelistDiff {
    code: string;
    oldPrice: Decimal | null;
    newPrice: Decimal;
    oldActionPrice?: Decimal | null;
    newActionPrice?: Decimal | null;
}

export interface PricelistWriterOptions {
    dryRun?: boolean;
}

export class PricelistWriter {
    constructor(
        private readonly apiClient: ShoptetApiClient,
        private readonly options: PricelistWriterOptions
    ) {}

    /**
     * Zpracuje diff a odesílá data do API v dávkách po 100.
     */
    public async processDiff(pricelistId: number, pricelistName: string, diffs: PricelistDiff[]) {
        const stats = {
            pricelistId,
            pricelistName,
            total: diffs.length,
            processed: 0,
            failed: 0,
            skipped: 0,
            dryRun: this.options.dryRun === true,
            errors: [] as string[],
            // Jen diffy z DÁVEK, které opravdu úspěšně prošly do Shoptetu -- volající
            // (sync-orchestrator.ts) tohle používá k zápisu do cache. Předtím se
            // cachovaly VŠECHNY diffy, jakmile uspěla aspoň jedna dávka v rámci
            // ceníku (`processed > 0`), i ty z DÁVKY, která selhala -- neškodilo to,
            // dokud cache nikdy nepřežila mezi běhy (FileCacheProvider), ale s
            // perzistentní cache (RemotePriceCache, 2026-08-12) by to znamenalo, že
            // produkt s neúspěšným zápisem do Shoptetu by se příště tiše přeskočil,
            // protože cache by nesprávně tvrdila, že už má novou cenu.
            successfulDiffs: [] as PricelistDiff[]
        };

        if (diffs.length === 0) {
            console.log(`PricelistWriter: Žádné změny pro ceník '${pricelistName}' (ID: ${pricelistId}).`);
            return stats;
        }

        console.log(`PricelistWriter: Nalezeno ${diffs.length} změn cen pro ceník '${pricelistName}' (ID: ${pricelistId}). (DryRun: ${stats.dryRun})`);

        // Logování diffů
        for (const diff of diffs) {
            const oldP = diff.oldPrice ? diff.oldPrice.toFixed(2) : 'N/A (Cold Cache)';
            const newP = diff.newPrice.toFixed(2);
            let actionStr = '';
            if (diff.newActionPrice !== undefined || diff.oldActionPrice !== undefined) {
                const oldAP = diff.oldActionPrice ? diff.oldActionPrice.toFixed(2) : 'N/A';
                const newAP = diff.newActionPrice ? diff.newActionPrice.toFixed(2) : 'None';
                if (oldAP !== newAP) {
                    actionStr = ` | Akce: ${oldAP} -> ${newAP}`;
                }
            }
            console.log(`[DIFF - ${pricelistName}] Kód: ${diff.code} | Cena: ${oldP} -> ${newP}${actionStr}`);
        }

        if (stats.dryRun) {
            stats.processed = diffs.length;
            console.log(`PricelistWriter [DRY RUN] dokončen pro '${pricelistName}'. Simulováno zpracování ${stats.processed} produktů.`);
            return stats;
        }

        // Tvorba Snapshotu před prvním zápisem v tomto běhu
        if (!stats.dryRun && diffs.length > 0) {
            try {
                const snapshotData = diffs.map(d => ({
                    code: d.code,
                    originalPrice: d.oldPrice ? d.oldPrice.toFixed(2) : null
                }));
                const snapshotDir = path.resolve('./.snapshots');
                if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });
                const snapshotPath = path.join(snapshotDir, `pricelist_${pricelistId}_rollback_${Date.now()}.json`);
                fs.writeFileSync(snapshotPath, JSON.stringify(snapshotData, null, 2), 'utf-8');
                GlobalStats.rollbackSnapshots++;
                console.log(`[SNAPSHOT] Vytvořen rollback snapshot pro ceník ${pricelistName}: ${snapshotPath}`);
            } catch (e) {
                console.warn(`[SNAPSHOT] Varování: Nepodařilo se vytvořit snapshot: ${e}`);
            }
        }

        // Chunking po 100 kusech pro reálný zápis
        const chunkSize = 100;
        for (let i = 0; i < diffs.length; i += chunkSize) {
            const chunk = diffs.slice(i, i + chunkSize);
            const batchPayload = chunk.map(d => {
                const item: Record<string, any> = {
                    code: d.code,
                    price: d.newPrice.toFixed(2)
                };
                if (d.newActionPrice !== undefined) {
                    item.actionPrice = d.newActionPrice !== null ? d.newActionPrice.toFixed(2) : null;
                }
                return item;
            });

            try {
                const reqStart = Date.now();
                const apiResult = await this.apiClient.updatePricelistBatch(pricelistId, batchPayload);
                const duration = Date.now() - reqStart;
                stats.processed += chunk.length;
                stats.successfulDiffs.push(...chunk);

                // Přidání požadovaného Audit Logu
                for (const item of chunk) {
                    const oldP = item.oldPrice ? item.oldPrice.toFixed(2) : 'N/A (Cold Cache)';
                    GlobalStats.auditLogs++;
                    console.log(`[AUDIT LOG] timestamp: ${apiResult.timestamp} | entity: PricelistItem | id: ${item.code} | endpoint: ${apiResult.endpoint} | requestId: ${apiResult.requestId} | HTTP status: ${apiResult.status} | duration: ${duration}ms | attempt: 1 | oldValue: ${oldP} | newValue: ${item.newPrice.toFixed(2)}`);
                }

                console.log(`[WRITE] Dávka ${Math.floor(i / chunkSize) + 1} úspěšně zapsána pro ceník ${pricelistName}.`);

                // Zjištěno 2026-08-14 (reconcile-pricelist-drift.ts po brandSaleDiscounts
                // rolloutu): Shoptet umí na PATCH pro kód, co na tomhle ceníku ještě NIKDY
                // neměl žádný záznam, vrátit HTTP 200 (žádné `errors`, prázdné `data`) a
                // přesto nic reálně nezapsat -- ověřeno živě (93280/93281/93282, DELPHIN),
                // druhý pokus o STEJNÝ zápis o pár vteřin později už uspěl. Shoptetova
                // odpověď mezi "opravdu zapsáno" a "tiše no-op" vůbec nerozlišuje (`data`
                // je `{}` v obou případech), takže se to nedá poznat z první odpovědi --
                // jediná dosud pozorovaná záchrana je slepý retry. Tohle NENÍ obecný retry
                // na chyby (na to slouží rateLimiter.execute) -- je to cílené jen na
                // položky, které na tomhle konkrétním ceníku ještě nikdy neměly cenu
                // (`oldPrice === null`, tzn. cache o nich dosud nic neví), protože právě
                // tahle situace -- první zápis na ceník, ne aktualizace existujícího
                // záznamu -- je to, co se pozorovalo jako rizikové. Běžná aktualizace už
                // existující položky tímhle rizikem netrpí.
                const firstTimeItems = chunk.filter(d => d.oldPrice === null);
                if (firstTimeItems.length > 0) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    const retryPayload = firstTimeItems.map(d => {
                        const item: Record<string, any> = { code: d.code, price: d.newPrice.toFixed(2) };
                        if (d.newActionPrice !== undefined) {
                            item.actionPrice = d.newActionPrice !== null ? d.newActionPrice.toFixed(2) : null;
                        }
                        return item;
                    });
                    try {
                        await this.apiClient.updatePricelistBatch(pricelistId, retryPayload);
                        console.log(`[WRITE] Potvrzující re-zápis pro ${firstTimeItems.length} nových položek (poprvé na ceníku ${pricelistName}) proveden.`);
                    } catch (retryErr: any) {
                        console.warn(`[WARNING] Potvrzující re-zápis pro ${firstTimeItems.length} nových položek selhal: ${retryErr.message} -- Stage 5 reconciliace by tohle měla stejně odchytit.`);
                    }
                }
            } catch (err: any) {
                console.error(`[ERROR] Chyba při zápisu dávky pro ceník ${pricelistName}:`, err.message);
                stats.errors.push(err.message);
                stats.failed += chunk.length;
            }
        }

        console.log(`PricelistWriter dokončen pro '${pricelistName}'. Zpracováno: ${stats.processed}, Selhalo: ${stats.failed}`);
        return stats;
    }
}
