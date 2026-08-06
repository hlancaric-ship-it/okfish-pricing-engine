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
const PRODUCT_CODE = process.env.PRODUCT_CODE || process.argv[2];

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
    if (!PRODUCT_CODE) throw new Error('PRODUCT_CODE not set (env var or first CLI arg)');
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set in .env');

    console.log(`=== ŽIVÝ ZÁPIS KUPÓNOVÝCH POLÍ PRO JEDEN PRODUKT: ${PRODUCT_CODE} ===`);

    const client = new ShoptetApiClient(token);
    const writer = new CouponSalesWriter(client, { dryRun: false }); // LIVE
    const { loyaltyTiers, brandLimits, categoryLimits } = loadPolicyConfig();

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
    const maxDiscountPct = parseNumber(row['maxDiscount']);
    const productMaxDiscount = maxDiscountPct !== undefined ? maxDiscountPct.dividedBy(100) : undefined;
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
