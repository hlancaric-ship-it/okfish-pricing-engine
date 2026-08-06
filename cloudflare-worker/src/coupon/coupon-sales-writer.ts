import { ShoptetApiClient, GlobalStats } from '../shoptet-api/client';
import { CouponWriteItem } from './compute-coupon-writes';
import { GUEST_PRICELIST_ID } from './tier-pricelist-map';
import * as fs from 'fs';
import * as path from 'path';

export interface CouponSalesWriterOptions {
    /** Defaults to true — no live API call unless explicitly turned off. */
    dryRun?: boolean;
}

/**
 * Writes CouponPolicy output (applyDiscountCoupon / maxDiscount, already converted
 * to discountCoupon / minPriceRatio by computeCouponWrites) to Shoptet via
 * updatePricelistSalesBatch. Mirrors PricelistWriter's dry-run + snapshot pattern,
 * kept as a fully separate class so the existing price-writing path is untouched.
 */
export class CouponSalesWriter {
    constructor(
        private readonly apiClient: ShoptetApiClient,
        private readonly options: CouponSalesWriterOptions = {}
    ) {}

    /** Defaults to dry-run: pass { dryRun: false } explicitly to write for real. */
    public async processTierBatch(pricelistId: number, tier: string, items: CouponWriteItem[]) {
        // BLOKACE ZNOVU ZAVEDENA 2026-08-06 (krátce po pokusu ji odstranit týž den).
        // Důvod pokusu: zjistili jsme, že "Maximálna povolená sleva" na GUEST není
        // obecný cenový strop, ale KUPÓNOVÝ strop -- funkčně stejné pole jako "Max.
        // sleva (%)" na ZR tierech, takže se zdálo bezpečné ho psát stejnou cestou.
        // Živý test to ale vyvrátil: `computeCouponWrites` čte `productMaxDiscount`
        // z NEPREFIXOVANÉHO `maxDiscount` sloupce feedu -- a to je PŘESNĚ to samé
        // pole, do kterého bychom chtěli zapsat výsledek. Je to kruhová závislost:
        // klient ručně nastaví GUEST kupón na 8% (aby 12% akce + 8% kupón = 20%
        // strop), feed tuhle 8% přečte jako by to byl nezávislý cenový strop
        // produktu, engine si z něj odečte už uplatněnou 12% akci a vyjde 0% --
        // čímž by automatika přepsala klientovu správnou ruční hodnotu na špatnou
        // nulu. Potvrzeno živě na produktu 999999 (klient to musel ručně opravit
        // zpět). Dokud GUEST nemá nezávislý zdroj stropu (jen brandLimits/
        // categoryLimits, nikdy feedovo vlastní maxDiscout), zůstává nepsaný.
        if (pricelistId === GUEST_PRICELIST_ID) {
            console.warn(`CouponSalesWriter: odmítám zápis do pricelistu ${GUEST_PRICELIST_ID} (GUEST/Hlavný cenník) — kruhová závislost na feedu, viz komentář výše. Přeskakuji ${items.length} položek.`);
            return {
                pricelistId, tier, total: items.length, processed: 0, failed: 0,
                dryRun: this.options.dryRun !== false, errors: [] as string[], skipped: true
            };
        }

        const dryRun = this.options.dryRun !== false; // default true
        const stats = {
            pricelistId,
            tier,
            total: items.length,
            processed: 0,
            failed: 0,
            dryRun,
            errors: [] as string[]
        };

        if (items.length === 0) {
            return stats;
        }

        console.log(`CouponSalesWriter: ${items.length} položek pro tier '${tier}' (pricelist ${pricelistId}). (DryRun: ${dryRun})`);
        // Per-item diff logging only for small batches — a full-catalog run would
        // otherwise flood stdout with 100k+ lines for no operational benefit.
        if (items.length <= 20) {
            for (const item of items) {
                console.log(`[COUPON DIFF - ${tier}] Kód: ${item.code} | applyDiscountCoupon: ${item.applyDiscountCoupon} | minPriceRatio: ${item.minPriceRatio.toFixed(4)}`);
            }
        }

        if (dryRun) {
            stats.processed = items.length;
            console.log(`CouponSalesWriter [DRY RUN] dokončen pro tier '${tier}'. Simulováno ${stats.processed} položek, žádný zápis neproběhl.`);
            return stats;
        }

        // Snapshot before any live write, same convention as PricelistWriter.
        try {
            const snapshotDir = path.resolve('./.snapshots');
            if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });
            const snapshotPath = path.join(snapshotDir, `coupon_sales_${pricelistId}_rollback_${Date.now()}.json`);
            fs.writeFileSync(snapshotPath, JSON.stringify(items.map(i => ({ code: i.code, tier: i.tier, applyDiscountCoupon: i.applyDiscountCoupon, minPriceRatio: i.minPriceRatio.toString() })), null, 2), 'utf-8');
            GlobalStats.rollbackSnapshots++;
            console.log(`[SNAPSHOT] Vytvořen rollback snapshot pro coupon sales (tier ${tier}): ${snapshotPath}`);
        } catch (e) {
            console.warn(`[SNAPSHOT] Varování: Nepodařilo se vytvořit snapshot: ${e}`);
        }

        const chunkSize = 100;
        for (let i = 0; i < items.length; i += chunkSize) {
            const chunk = items.slice(i, i + chunkSize);
            const batchPayload = chunk.map(item => ({
                code: item.code,
                discountCoupon: item.applyDiscountCoupon,
                minPriceRatio: item.minPriceRatio.toFixed(4)
            }));

            try {
                await this.apiClient.updatePricelistSalesBatch(pricelistId, batchPayload);
                stats.processed += chunk.length;
                console.log(`[WRITE] Dávka ${Math.floor(i / chunkSize) + 1} úspěšně zapsána pro tier ${tier}.`);
            } catch (err: any) {
                console.error(`[ERROR] Chyba při zápisu coupon sales dávky pro tier ${tier}:`, err.message);
                stats.errors.push(err.message);
                stats.failed += chunk.length;
            }
        }

        console.log(`CouponSalesWriter dokončen pro tier '${tier}'. Zpracováno: ${stats.processed}, Selhalo: ${stats.failed}`);
        return stats;
    }
}
