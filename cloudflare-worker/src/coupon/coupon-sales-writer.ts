import { ShoptetApiClient, GlobalStats } from '../shoptet-api/client';
import { CouponWriteItem } from './compute-coupon-writes';
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
        // nulu. Potvrzeno živě na produktu 999999.
        //
        // OPRAVENO 2026-08-06 (týž den): oba live zápisové skripty
        // (sync-coupon-fields-live.ts, sync-coupon-fields-single-product.ts) teď
        // NIKDY nečtou feedovo `maxDiscount` jako productMaxDiscount (stejně jako to
        // už dřív dělal export-coupon-fields-csv.ts) -- jediný zdroj stropu je
        // nezávislý brandLimits/categoryLimits z policy-v1.json. Tím kruhová
        // závislost mizí i pro GUEST (nic už nečte GUEST vlastní hodnotu jako
        // vstup), takže zápis je bezpečný. Ověřeno živě na 999999: po opravě dává
        // GUEST i ZR4 shodně 8%, ne 0%.
        const dryRun = this.options.dryRun !== false; // default true
        const stats = {
            pricelistId,
            tier,
            total: items.length,
            processed: 0,
            failed: 0,
            dryRun,
            errors: [] as string[],
            // Zavedeno 2026-08-15 stejně jako u PricelistWriter (viz jeho komentář) --
            // Shoptet umí PATCH tiše ignorovat i tady, ne jen u cen. Na rozdíl od
            // PricelistWriter tady nemáme `oldValue`, abychom poznali "první zápis"
            // levněji, takže se ověřuje každá zapsaná položka -- v běžném
            // inkrementálním syncu je diffů jen pár, u plošného re-syncu je to dražší,
            // ale ten je řídká výjimka, ne běžný provoz.
            verificationFailures: [] as Array<{ code: string; expected: { discountCoupon: boolean; minPriceRatio: string }; actual: { discountCoupon: boolean; minPriceRatio: string } | null }>
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

                await new Promise(resolve => setTimeout(resolve, 2000));
                for (const item of chunk) {
                    const expected = { discountCoupon: item.applyDiscountCoupon, minPriceRatio: item.minPriceRatio.toFixed(4) };
                    let verified;
                    try {
                        verified = await this.apiClient.getPricelistItemByCode(pricelistId, item.code);
                    } catch (verifyErr: any) {
                        console.warn(`[WARNING] Verifikace coupon zápisu pro ${item.code} (tier ${tier}) selhala na GET: ${verifyErr.message}.`);
                    }
                    const actual = verified?.sales
                        ? { discountCoupon: verified.sales.discountCoupon, minPriceRatio: verified.sales.minPriceRatio }
                        : null;
                    const matches = actual !== null
                        && actual.discountCoupon === expected.discountCoupon
                        && Number(actual.minPriceRatio).toFixed(4) === expected.minPriceRatio;
                    if (matches) continue;
                    console.warn(`[WARNING] ${item.code} na tieru ${tier}: čekáno discountCoupon=${expected.discountCoupon}/minPriceRatio=${expected.minPriceRatio}, Shoptet má ${actual ? `discountCoupon=${actual.discountCoupon}/minPriceRatio=${actual.minPriceRatio}` : 'CHYBÍ ZÁZNAM'}. Zkouším opravný zápis.`);
                    try {
                        await this.apiClient.updatePricelistSalesBatch(pricelistId, [{
                            code: item.code,
                            discountCoupon: item.applyDiscountCoupon,
                            minPriceRatio: item.minPriceRatio.toFixed(4)
                        }]);
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        const reverified = await this.apiClient.getPricelistItemByCode(pricelistId, item.code);
                        const reactual = reverified?.sales
                            ? { discountCoupon: reverified.sales.discountCoupon, minPriceRatio: reverified.sales.minPriceRatio }
                            : null;
                        const rematches = reactual !== null
                            && reactual.discountCoupon === expected.discountCoupon
                            && Number(reactual.minPriceRatio).toFixed(4) === expected.minPriceRatio;
                        if (rematches) {
                            console.log(`[VERIFY] ${item.code} na tieru ${tier}: opravný zápis potvrzen.`);
                        } else {
                            console.error(`[ALERT] ${item.code} na tieru ${tier}: i po opravném zápisu neshoda -- čekáno discountCoupon=${expected.discountCoupon}/minPriceRatio=${expected.minPriceRatio}, Shoptet má ${reactual ? `discountCoupon=${reactual.discountCoupon}/minPriceRatio=${reactual.minPriceRatio}` : 'CHYBÍ ZÁZNAM'}.`);
                            stats.verificationFailures.push({ code: item.code, expected, actual: reactual });
                        }
                    } catch (retryErr: any) {
                        console.error(`[ALERT] ${item.code} na tieru ${tier}: opravný zápis selhal: ${retryErr.message}.`);
                        stats.verificationFailures.push({ code: item.code, expected, actual: null });
                    }
                }
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
