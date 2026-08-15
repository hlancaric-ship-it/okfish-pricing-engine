// Forces a full pricelist (all 10 tiers) + coupon-fields recompute and write for
// a fixed set of brands, matched by PRODUCT NAME (not the manufacturer field --
// explicit choice, per Jan 2026-08-15), instead of running the full-catalog sync.
//
// Built for a one-off need: DELPHIN / DELPHIN BOMB / MIVARDI / MIKADO all have a
// year-round brandSaleDiscounts entry in policy-v1.json, and the tier-price fix
// from 2026-08-15 (pricing-engine-platform, DiscountLimitPolicy.ts /
// engine/pricing.ts -- a shallow action/brand-sale price no longer unconditionally
// beats a deeper, cap-limited loyalty tier) needs to be pushed out for exactly
// these brands' products, live, without touching the rest of the catalog.
//
// Does NOT touch sync-orchestrator.ts, the price cache, or force-sync-products.json
// -- this is a standalone batch job reading straight from the master feed, same
// pattern as sync-coupon-fields-live.ts and set-brand-cap-live.ts. No product GUID
// is needed anywhere in this script: both updatePricelistBatch() and
// updatePricelistSalesBatch() (client.ts) write by `code`, not guid.
//
// Usage:
//   npx tsx src/cli/force-recalc-brands-live.ts             (dry run -- default,
//                                                              prints every diff,
//                                                              writes nothing)
//   npx tsx src/cli/force-recalc-brands-live.ts --live       (live write)
import * as fs from 'fs';
import * as path from 'path';
import Decimal from 'decimal.js';
import { CsvParserStream } from '../csv/csv-parser';
import { calculateAllTierPrices, CsvRow } from '../engine/pricing';
import { TIER_NAMES } from '../engine/config';
import { computeCouponWrites, CouponWriteItem } from '../coupon/compute-coupon-writes';
import { TIER_PRICELIST_MAP, ALL_PRICELISTS_MAP } from '../coupon/tier-pricelist-map';
import { ShoptetApiClient } from '../shoptet-api/client';
import { PricelistWriter, PricelistDiff } from '../shoptet-api/pricelist-writer';
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

const isLive = process.argv.includes('--live');

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
        categoryLimits: toDecimalMap(policy.categoryLimits),
    };
}

// Longest/most specific string first -- "DELPHIN BOMB" must be checked before the
// plain "DELPHIN" substring, or every DELPHIN BOMB product would be misclassified.
const BRAND_NAME_MATCHERS = ['DELPHIN BOMB', 'DELPHIN', 'MIVARDI', 'MIKADO'];

function matchBrand(productName: string): string | undefined {
    const upper = productName.toUpperCase();
    return BRAND_NAME_MATCHERS.find((b) => upper.includes(b));
}

async function main() {
    const feedUrl = process.env.MASTER_FEED_URL;
    if (!feedUrl) throw new Error('MASTER_FEED_URL not set in .env');
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set in .env');

    console.log(`=== FORCE RECALC — brands: ${BRAND_NAME_MATCHERS.join(', ')} (match by product NAME) ===`);
    console.log(`Mode: ${isLive ? 'LIVE WRITE' : 'DRY RUN (pass --live to actually write)'}\n`);

    const { loyaltyTiers, brandLimits, categoryLimits } = loadPolicyConfig();
    const client = new ShoptetApiClient(token);

    // Bulk-fetch each tier pricelist's CURRENT state up front (paginated, ~17
    // requests per pricelist for the full catalog) instead of leaving every
    // diff's oldPrice as null. pricelist-writer.ts treats oldPrice === null as
    // "possibly never had a record on this pricelist before" and runs a slow,
    // sequential GET-verify-and-retry safety check for every such item (with
    // built-in delays) -- correct and necessary for genuinely new items, but
    // leaving it null for THOUSANDS of already-priced products (2026-08-15,
    // first version of this script) made the whole run crawl at ~2s/item for
    // no reason, since almost all of them already had a real price. Fetching
    // the real oldPrice here means that expensive path only fires for items
    // that are genuinely missing a record -- the actual case it exists for.
    console.log('Fetching current pricelist state for all 10 tiers (one-time bulk fetch)...');
    const currentPriceByTierAndCode: Record<string, Map<string, string>> = {};
    for (const [tier, pricelistId] of Object.entries(TIER_PRICELIST_MAP)) {
        console.log(`  ${tier} (pricelist ${pricelistId})...`);
        const items = await client.getPricelistItems(pricelistId);
        const map = new Map<string, string>();
        for (const item of items) {
            if (item?.code && item?.price?.price) map.set(item.code, item.price.price);
        }
        currentPriceByTierAndCode[tier] = map;
        console.log(`    -> ${map.size} produktů s cenou na tomto ceníku.`);
    }

    console.log('\nFetching master feed...');
    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) throw new Error(`Master feed fetch failed: HTTP ${res.status}`);

    const pricelistDiffsByTier: Record<string, PricelistDiff[]> = {};
    for (const tier of TIER_NAMES) pricelistDiffsByTier[tier] = [];
    const couponItemsByTier: Record<string, CouponWriteItem[]> = {};
    for (const tier of Object.keys(ALL_PRICELISTS_MAP)) couponItemsByTier[tier] = [];

    const matchedByBrand: Record<string, number> = {};
    let scanned = 0;
    let matched = 0;
    let skippedNoPrice = 0;

    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as CsvRow;
        scanned++;

        const name = row['name'] || '';
        const brand = matchBrand(name);
        if (!brand) continue;

        const code = row['code'];
        if (!code) continue;

        const basePrice = parseFloat((row['price'] || row['standardPrice'] || '0').replace(',', '.'));
        if (!basePrice || basePrice <= 0) {
            skippedNoPrice++;
            continue;
        }

        matched++;
        matchedByBrand[brand] = (matchedByBrand[brand] || 0) + 1;

        // 1. Tier pricelist recompute (all 10 tiers), via the fixed engine.
        const tierPrices = calculateAllTierPrices(row);
        for (const tier of TIER_NAMES) {
            const result = tierPrices[tier];
            if (!result) continue;
            const existingPriceStr = currentPriceByTierAndCode[tier]?.get(code);
            const oldPrice = existingPriceStr ? new Decimal(existingPriceStr) : null;
            const newPrice = new Decimal(result.price);
            // Skip entirely if nothing actually changes -- no point sending a
            // no-op PATCH for products already at the correct price on this tier.
            if (oldPrice !== null && oldPrice.equals(newPrice)) continue;
            pricelistDiffsByTier[tier].push({ code, oldPrice, newPrice });
        }

        // 2. Coupon fields recompute (all 10 tiers + GUEST), same production function
        // sync-coupon-fields-live.ts uses for the full-catalog run.
        const actionPrice = row['actionPrice'] ? parseFloat(row['actionPrice'].replace(',', '.')) : undefined;
        const manufacturer = row['manufacturer'] || undefined;
        const category = row['categoryText'] || undefined;
        const allowLoyaltyDiscount = row['applyLoyaltyDiscount'] === undefined || ['1', 'true', 'yes'].includes(row['applyLoyaltyDiscount']);
        const couponItems = computeCouponWrites(
            {
                code,
                basePrice: new Decimal(basePrice),
                actionPrice: actionPrice ? new Decimal(actionPrice) : undefined,
                productMaxDiscount: undefined,
                manufacturer,
                category,
                allowLoyaltyDiscount,
            },
            loyaltyTiers,
            brandLimits,
            categoryLimits
        );
        for (const item of couponItems) couponItemsByTier[item.tier].push(item);

        if (scanned % 5000 === 0) console.log(`...scanned ${scanned} rows, matched ${matched} so far`);
    }

    console.log(`\nFeed scanned: ${scanned} rows. Matched: ${matched} (skipped, no price: ${skippedNoPrice}).`);
    for (const [brand, count] of Object.entries(matchedByBrand)) console.log(`  ${brand}: ${count} produktů`);

    const pricelistWriter = new PricelistWriter(client, { dryRun: !isLive });
    const couponWriter = new CouponSalesWriter(client, { dryRun: !isLive });

    let anyFailed = false;

    console.log('\n--- Ceníky (10 tierů) ---');
    for (const [tier, pricelistId] of Object.entries(TIER_PRICELIST_MAP)) {
        const diffs = pricelistDiffsByTier[tier];
        if (diffs.length === 0) continue;
        const stats = await pricelistWriter.processDiff(pricelistId, tier, diffs);
        console.log(`${tier}: zpracováno=${stats.processed} selhalo=${stats.failed} ověřovacích_chyb=${stats.verificationFailures.length}`);
        if (stats.failed > 0 || stats.verificationFailures.length > 0) anyFailed = true;
    }

    console.log('\n--- Kupónová pole (10 tierů + GUEST) ---');
    for (const [tier, pricelistId] of Object.entries(ALL_PRICELISTS_MAP)) {
        const items = couponItemsByTier[tier];
        if (items.length === 0) continue;
        const stats = await couponWriter.processTierBatch(pricelistId, tier, items);
        console.log(`${tier}: zpracováno=${stats.processed} selhalo=${stats.failed}`);
        if (stats.failed > 0) anyFailed = true;
    }

    console.log(`\n=== ${isLive ? 'ŽIVÝ ZÁPIS' : 'DRY RUN'} DOKONČEN ===`);
    if (anyFailed) {
        console.error('CHYBA: aspoň jedna dávka selhala nebo neprošla ověřením -- viz stats výše. NEPOVAŽOVAT za úspěšný běh.');
        process.exit(1);
    }
}

main().catch((e) => {
    console.error('CHYBA:', e);
    process.exit(1);
});
