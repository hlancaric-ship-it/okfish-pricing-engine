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
        // BUG (opraveno, 2026-08-03): pricelist ID 1 ("Hlavný cenník") NENÍ jen další
        // věrnostní ceník pro GUEST zákazníky — je to ten samý záznam, ze kterého
        // Shoptet čte a zobrazuje "Maximální povolená sleva" přímo na produktu
        // (PATCH /pricelists/1 zapisuje do stejného pole sales.minPriceRatio). Zápis
        // GUEST tieru sem přepisoval skutečný, ručně/importem nastavený strop
        // produktu tou dopočítanou "zbývající" hodnotou — a to na KAŽDÉM běhu, včetně
        // automatického cronu 2x denně. Guest zákazníci jsou už chránění tím
        // existujícím stropem nativně (Shoptet ho sám vynucuje), není potřeba sem nic
        // zapisovat — proto se tenhle zápis teď tvrdě odmítá bez ohledu na to, odkud
        // je processTierBatch zavolán.
        if (pricelistId === GUEST_PRICELIST_ID) {
            console.warn(`CouponSalesWriter: odmítám zápis do pricelistu ${GUEST_PRICELIST_ID} (GUEST/Hlavný cenník) — přepisovalo by to skutečný strop max. slevy na produktu. Přeskakuji ${items.length} položek.`);
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
