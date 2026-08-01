// FULL CATALOG LIVE WRITE. Computes CouponPolicy output for every product/tier from
// the master feed and writes it to Shoptet via CouponSalesWriter (dryRun: false).
// Snapshots are taken per-tier-batch before each live write (see CouponSalesWriter).
//
// Usage: npm run sync-coupon-fields-live   (from cloudflare-worker/)
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

function parseNumber(val: string | undefined): Decimal | undefined {
    if (!val || val.trim() === '') return undefined;
    const normalized = val.replace(',', '.').replace(/\s/g, '');
    const n = new Decimal(normalized);
    return n.isNaN() ? undefined : n;
}

// Same convention as engine/pricing.ts's resolveAllowLoyaltyDiscount(): absent
// defaults to allowed, only an explicit falsy-looking value turns it off.
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
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set in .env');

    const client = new ShoptetApiClient(token);
    const writer = new CouponSalesWriter(client, { dryRun: false }); // LIVE

    const { loyaltyTiers, brandLimits, categoryLimits } = loadPolicyConfig();
    console.log('=== ŽIVÝ ZÁPIS NA CELÝ KATALOG ===');
    console.log('Loyalty tiers:', Object.keys(loyaltyTiers).join(', '));

    console.log('Fetching master feed...');
    const res = await fetch(MASTER_FEED_URL);
    if (!res.ok || !res.body) throw new Error(`Master feed fetch failed: HTTP ${res.status}`);

    // Group by tier so we can batch-write per pricelist (100 items/request).
    const byTier: Record<string, CouponWriteItem[]> = {};
    for (const tier of Object.keys(ALL_PRICELISTS_MAP)) byTier[tier] = [];

    let productCount = 0;
    let skippedNoPrice = 0;

    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        const code = row['code'];
        if (!code) continue;

        const basePrice = parseNumber(row['price'] || row['standardPrice']);
        if (!basePrice || basePrice.lessThanOrEqualTo(0)) {
            skippedNoPrice++;
            continue;
        }

        const actionPrice = parseNumber(row['actionPrice']);
        const maxDiscountPct = parseNumber(row['maxDiscount']);
        const productMaxDiscount = maxDiscountPct !== undefined ? maxDiscountPct.dividedBy(100) : undefined;
        const manufacturer = row['manufacturer'] || undefined;
        const category = row['categoryText'] || undefined;
        const allowLoyaltyDiscount = resolveAllowLoyaltyDiscount(row);

        productCount++;
        const items = computeCouponWrites(
            { code, basePrice, actionPrice, productMaxDiscount, manufacturer, category, allowLoyaltyDiscount },
            loyaltyTiers, brandLimits, categoryLimits
        );
        for (const item of items) byTier[item.tier].push(item);

        if (productCount % 2000 === 0) console.log(`...načteno ${productCount} produktů z feedu`);
    }

    console.log(`\nFeed načten: ${productCount} produktů (přeskočeno bez ceny: ${skippedNoPrice}).`);
    console.log('Začínám zápis po tierech...\n');

    for (const [tier, pricelistId] of Object.entries(ALL_PRICELISTS_MAP)) {
        const items = byTier[tier];
        console.log(`--- Tier ${tier} (pricelist ${pricelistId}): ${items.length} položek ---`);
        const stats = await writer.processTierBatch(pricelistId, tier, items);
        console.log(`Hotovo: zpracováno=${stats.processed} selhalo=${stats.failed}\n`);
    }

    console.log('=== CELÝ KATALOG ZAPSÁN ===');
}

main().catch(e => { console.error('CHYBA:', e); process.exit(1); });
