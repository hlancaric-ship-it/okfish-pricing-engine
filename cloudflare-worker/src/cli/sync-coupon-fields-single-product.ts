// LIVE WRITE FOR ONE PRODUCT ONLY. Same CouponPolicy/computeCouponWrites logic as
// sync-coupon-fields-live.ts (the full-catalog version), but scoped to a single
// product code -- meant to be triggered by the product:create/product:update
// Shoptet webhook (via sync.yml's repository_dispatch step) so a newly added or
// edited product gets its coupon fields (applyDiscountCoupon/minPriceRatio) written
// within seconds, without re-processing the other ~16k products on the same trigger.
//
// Usage: PRODUCT_CODE=12345 npx tsx src/cli/sync-coupon-fields-single-product.ts
import * as fs from 'fs';
import * as path from 'path';
import Decimal from 'decimal.js';
import { CsvParserStream } from '../csv/csv-parser';
import { computeCouponWrites, CouponWriteItem } from '../coupon/compute-coupon-writes';
import { ALL_PRICELISTS_MAP } from '../coupon/tier-pricelist-map';
import { ShoptetApiClient } from '../shoptet-api/client';
import { CouponSalesWriter } from '../coupon/coupon-sales-writer';

function loadRootEnv() {
    const envPath = path.resolve(__dirname, '../../../.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
}
loadRootEnv();

const MASTER_FEED_URL = process.env.MASTER_FEED_URL;
const PRODUCT_CODE_OR_GUID = process.env.PRODUCT_CODE || process.argv[2];

// Confirmed live 2026-08-06: for product:create/product:update webhooks, Shoptet's
// eventInstance (and every plausible spot we checked in the "full" payload) is its
// OWN internal GUID, not the merchant `code` our feed/pricing engine keys on -- same
// code/internal-ID split already seen with data-micro-product-id in vip_catalog.js.
// A GUID always has hyphens in this fixed position; a merchant code never does.
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseNumber(val: string | undefined): Decimal | undefined {
    if (!val || val.trim() === '') return undefined;
    const normalized = val.replace(',', '.').replace(/\s/g, '');
    const n = new Decimal(normalized);
    return n.isNaN() ? undefined : n;
}

// Same convention as engine/pricing.ts's resolveAllowLoyaltyDiscount().
function resolveAllowLoyaltyDiscount(row: Record<string, string>): boolean {
    const val = row['applyLoyaltyDiscount'];
    return val === '1' || val === 'true' || val === 'yes' || val === undefined;
}

function loadPolicyConfig(): { loyaltyTiers: Record<string, Decimal>; brandLimits: Record<string, Decimal>; categoryLimits: Record<string, Decimal> } {
    const policyPath = path.resolve(__dirname, '../../../src/config/policies/policy-v1.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf-8'));

    const toDecimalMap = (obj: Record<string, number> | undefined): Record<string, Decimal> => {
        const out: Record<string, Decimal> = {};
        for (const [k, v] of Object.entries(obj || {})) out[k] = new Decimal(v);
        return out;
    };

    return {
        loyaltyTiers: toDecimalMap(policy.loyaltyTiers),
        brandLimits: toDecimalMap(policy.brandLimits),
        categoryLimits: toDecimalMap(policy.categoryLimits)
    };
}

async function main() {
    if (!MASTER_FEED_URL) throw new Error('MASTER_FEED_URL not set in .env');
    if (!PRODUCT_CODE_OR_GUID) throw new Error('PRODUCT_CODE not set (env var or first CLI arg)');
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set in .env');

    const client = new ShoptetApiClient(token);
    const writer = new CouponSalesWriter(client, { dryRun: false }); // LIVE
    const { loyaltyTiers, brandLimits, categoryLimits } = loadPolicyConfig();

    let PRODUCT_CODE = PRODUCT_CODE_OR_GUID;
    if (GUID_PATTERN.test(PRODUCT_CODE_OR_GUID)) {
        console.log(`${PRODUCT_CODE_OR_GUID} vypadá jako Shoptet GUID, ne merchant kód -- dohledávám skutečný code přes API...`);
        const product = await client.getProductDetail(PRODUCT_CODE_OR_GUID);
        // BUG (opraveno 2026-08-13, součást INC-010): `product.code` na top-level
        // NEEXISTUJE -- Shoptet vrací merchant kód jen uvnitř `product.variants[].code`
        // (ověřeno živě proti reálnému GUID). Tenhle skript byl proto rozbitý stejně
        // jako products-reader.ts, jen si toho nikdo nevšiml, protože Shoptet webhook
        // pro tyhle produkty (99459/103525) vůbec nespustil krok, který ho volá.
        const resolvedCode = product?.variants?.[0]?.code || product?.code;
        if (!resolvedCode) {
            console.warn(`[WARNING] Produkt s GUID ${PRODUCT_CODE_OR_GUID} nebyl nalezen (smazaný, nebo se ještě nestihl propsat). Přeskakuji.`);
            return;
        }
        PRODUCT_CODE = resolvedCode;
        console.log(`Dohledáno: GUID ${PRODUCT_CODE_OR_GUID} -> code ${PRODUCT_CODE}`);
    }

    console.log(`=== ŽIVÝ ZÁPIS KUPÓNOVÝCH POLÍ PRO JEDEN PRODUKT: ${PRODUCT_CODE} ===`);

    console.log('Fetching master feed...');
    const res = await fetch(MASTER_FEED_URL);
    if (!res.ok || !res.body) throw new Error(`Master feed fetch failed: HTTP ${res.status}`);

    let row: Record<string, string> | undefined;
    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const r = value as Record<string, string>;
        if (r['code'] === PRODUCT_CODE) {
            row = r;
            reader.cancel().catch(() => {});
            break;
        }
    }

    if (!row) {
        console.warn(`[WARNING] Produkt s kódem ${PRODUCT_CODE} nebyl v master feedu nalezen (ještě se nestihl propsat, nebo byl smazán). Přeskakuji.`);
        return;
    }

    const basePrice = parseNumber(row['price'] || row['standardPrice']);
    if (!basePrice || basePrice.lessThanOrEqualTo(0)) {
        console.warn(`[WARNING] Produkt ${PRODUCT_CODE} nemá platnou cenu ve feedu. Přeskakuji.`);
        return;
    }

    const actionPrice = parseNumber(row['actionPrice']);
    // Deliberately NOT reading row['maxDiscount'] -- same reasoning as
    // export-coupon-fields-csv.ts: that column is GUEST's own coupon-room field
    // (self-referential, see coupon-sales-writer.ts's GUEST block comment), never a
    // real independent cap. resolveEffectiveLimit() falls back to brandLimits/
    // categoryLimits on its own when productMaxDiscount is undefined.
    const productMaxDiscount = undefined;
    const manufacturer = row['manufacturer'] || undefined;
    const category = row['categoryText'] || undefined;
    const allowLoyaltyDiscount = resolveAllowLoyaltyDiscount(row);

    const items = computeCouponWrites(
        { code: PRODUCT_CODE, basePrice, actionPrice, productMaxDiscount, manufacturer, category, allowLoyaltyDiscount },
        loyaltyTiers, brandLimits, categoryLimits
    );

    const byTier: Record<string, CouponWriteItem[]> = {};
    for (const item of items) {
        byTier[item.tier] = byTier[item.tier] || [];
        byTier[item.tier].push(item);
    }

    for (const [tier, pricelistId] of Object.entries(ALL_PRICELISTS_MAP)) {
        const tierItems = byTier[tier] || [];
        if (tierItems.length === 0) continue;
        const stats = await writer.processTierBatch(pricelistId, tier, tierItems);
        console.log(`Tier ${tier}: zpracováno=${stats.processed} selhalo=${stats.failed}`);
    }

    console.log(`=== HOTOVO: produkt ${PRODUCT_CODE} zapsán napříč tiery ===`);
}

main().catch(e => { console.error('CHYBA:', e); process.exit(1); });
