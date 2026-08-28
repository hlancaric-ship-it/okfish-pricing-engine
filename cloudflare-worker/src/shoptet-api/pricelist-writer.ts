import { ShoptetApiClient, GlobalStats, ShoptetPricelistItem } from './client';
import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';

export interface PricelistDiff {
    code: string;
    oldPrice: Decimal | null;
    newPrice: Decimal;
    oldActionPrice?: Decimal | null;
    newActionPrice?: Decimal | null;
    vatRate?: string;
    includingVat?: boolean;
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
            successfulDiffs: [] as PricelistDiff[],
            // Položky, co i po opravném zápisu NEODPOVÍDAJÍ tomu, co jsme zapsat chtěli
            // -- na rozdíl od stats.errors (HTTP/network chyba) je tohle Shoptet, co
            // tiše přijal zápis (HTTP 200) a přesto nemá správnou hodnotu. Zavedeno
            // 2026-08-15 po INC-010/reconciliaci nálezu (produkt 77764 a další
            // chybějící ZR20/ZR25 zápisy) -- volající (sync-orchestrator.ts) na tohle
            // musí fail-closed reagovat, ne to jen zalogovat a jet dál.
            verificationFailures: [] as Array<{ code: string; expected: string; actual: string | null }>
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
                    price: d.newPrice.toFixed(2),
                    vatRate: d.vatRate || "23.00",
                    includingVat: d.includingVat !== undefined ? d.includingVat : true
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

                // Přidání požadovaného Audit Logu
                for (const item of chunk) {
                    const oldP = item.oldPrice ? item.oldPrice.toFixed(2) : 'N/A (Cold Cache)';
                    GlobalStats.auditLogs++;
                    console.log(`[AUDIT LOG] timestamp: ${apiResult.timestamp} | entity: PricelistItem | id: ${item.code} | endpoint: ${apiResult.endpoint} | requestId: ${apiResult.requestId} | HTTP status: ${apiResult.status} | duration: ${duration}ms | attempt: 1 | oldValue: ${oldP} | newValue: ${item.newPrice.toFixed(2)}`);
                }

                console.log(`[WRITE] Dávka ${Math.floor(i / chunkSize) + 1} úspěšně zapsána pro ceník ${pricelistName}.`);

                const failedCodesInChunk = new Set<string>();

                // Zjištěno 2026-08-14 (reconcile-pricelist-drift.ts po brandSaleDiscounts
                // rolloutu): Shoptet umí na PATCH pro kód, co na tomhle ceníku ještě NIKDY
                // neměl žádný záznam, vrátit HTTP 200 (žádné `errors`, prázdné `data`) a
                // přesto nic reálně nezapsat -- ověřeno živě (93280/93281/93282, DELPHIN).
                // Shoptetova odpověď mezi "opravdu zapsáno" a "tiše no-op" vůbec
                // nerozlišuje (`data` je `{}` v obou případech), takže se to nedá poznat
                // z první odpovědi. PŮVODNĚ (do 2026-08-14) se tohle řešilo slepým
                // retry -- zkusit zápis znovu, bez ověření, jestli to bylo vůbec potřeba.
                // ZMĚNĚNO 2026-08-15 (na Janovo přímé zadání, po reconciliaci nálezu
                // produktu 77764 -- chybějící ZR20/ZR25 zápis, co si dřív nikdo
                // nevšiml až do druhého dne) na SKUTEČNOU verifikaci: přečíst zpátky
                // přesně to, co se právě zapisovalo, a porovnat. Jen jeden lehký GET
                // navíc na kód v běžném (fungujícím) případě -- teprve při neshodě se
                // provede opravný zápis + druhé ověření. Cíleno jen na položky, které
                // na tomhle konkrétním ceníku ještě nikdy neměly cenu
                // (`oldPrice === null`) -- stejné zúžení rizika jako předtím, běžná
                // aktualizace existující položky tímhle rizikem netrpí.
                const firstTimeItems = chunk.filter(d => d.oldPrice === null);
                if (firstTimeItems.length > 0) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    for (const d of firstTimeItems) {
                        const expected = d.newPrice.toFixed(2);
                        let verified: ShoptetPricelistItem | null = null;
                        try {
                            verified = await this.apiClient.getPricelistItemByCode(pricelistId, d.code);
                        } catch (verifyErr: any) {
                            console.warn(`[WARNING] Verifikace zápisu pro ${d.code} (poprvé na ceníku ${pricelistName}) selhala na GET: ${verifyErr.message}.`);
                        }
                        const actual = verified?.price?.price ? new Decimal(verified.price.price).toFixed(2) : null;
                        if (actual === expected) {
                            console.log(`[VERIFY] ${d.code} na ceníku ${pricelistName}: potvrzeno ${actual}.`);
                            continue;
                        }
                        console.warn(`[WARNING] ${d.code} na ceníku ${pricelistName}: čekáno ${expected}, Shoptet má ${actual ?? 'CHYBÍ ZÁZNAM'}. Zkouším opravný zápis.`);
                        try {
                            const retryItem: Record<string, any> = { code: d.code, price: expected };
                            if (d.newActionPrice !== undefined) {
                                retryItem.actionPrice = d.newActionPrice !== null ? d.newActionPrice.toFixed(2) : null;
                            }
                            await this.apiClient.updatePricelistBatch(pricelistId, [retryItem]);
                            await new Promise(resolve => setTimeout(resolve, 2000));
                            const reverified = await this.apiClient.getPricelistItemByCode(pricelistId, d.code);
                            const reactual = reverified?.price?.price ? new Decimal(reverified.price.price).toFixed(2) : null;
                            if (reactual === expected) {
                                console.log(`[VERIFY] ${d.code} na ceníku ${pricelistName}: opravný zápis potvrzen, ${reactual}.`);
                            } else {
                                console.error(`[ALERT] ${d.code} na ceníku ${pricelistName}: i po opravném zápisu neshoda -- čekáno ${expected}, Shoptet má ${reactual ?? 'CHYBÍ ZÁZNAM'}.`);
                                failedCodesInChunk.add(d.code);
                                stats.verificationFailures.push({ code: d.code, expected, actual: reactual });
                            }
                        } catch (retryErr: any) {
                            console.error(`[ALERT] ${d.code} na ceníku ${pricelistName}: opravný zápis selhal: ${retryErr.message}.`);
                            failedCodesInChunk.add(d.code);
                            stats.verificationFailures.push({ code: d.code, expected, actual: null });
                        }
                    }
                }

                // Bezpečný zápis do cache: Pouze položky, u kterých je prokázáno,
                // že je Shoptet skutečně uložil. Zabraňuje cache poisoning.
                stats.successfulDiffs.push(...chunk.filter(d => !failedCodesInChunk.has(d.code)));

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
