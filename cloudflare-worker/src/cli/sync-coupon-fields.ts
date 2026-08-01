// Computes CouponPolicy output (applyDiscountCoupon / minPriceRatio) for every
// product and every loyalty tier, from the same master feed sync-products.ts reads.
//
// DRY-RUN ONLY in this version: it never calls the Shoptet API. It writes a JSON
// report (coupon-dry-run-report.json) and prints a per-tier summary, so the numbers
// can be reviewed by a human before any live-write path is built/enabled.
//
// Usage: npm run sync-coupon-fields   (from cloudflare-worker/)
import * as fs from 'fs';
import * as path from 'path';
import Decimal from 'decimal.js';
import { CsvParserStream } from '../csv/csv-parser';
import { computeCouponWrites, CouponWriteItem } from '../coupon/compute-coupon-writes';
import { ALL_PRICELISTS_MAP } from '../coupon/tier-pricelist-map';

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

// Same comma-decimal parsing convention as engine/pricing.ts's parsePrice(), kept as
// a local copy (not imported) to avoid coupling this CLI's number handling to that
// file's internals — it's a tiny, stable piece of logic.
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

// Loads loyalty tier discounts and brand/category limits, straight from the same
// policy-v1.json the rest of the engine treats as the single source of truth.
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

    const { loyaltyTiers, brandLimits, categoryLimits } = loadPolicyConfig();
    console.log('Loyalty tiers loaded:', Object.keys(loyaltyTiers).join(', '));

    console.log('Fetching master feed...');
    const res = await fetch(MASTER_FEED_URL);
    if (!res.ok || !res.body) throw new Error(`Master feed fetch failed: HTTP ${res.status}`);

    // Per-tier counters for the console summary.
    const tierStats: Record<string, { total: number; on: number; off: number }> = {};
    for (const tier of Object.keys(ALL_PRICELISTS_MAP)) {
        tierStats[tier] = { total: 0, on: 0, off: 0 };
    }

    const reportRows: Array<{ code: string; tier: string; pricelistId: number; applyDiscountCoupon: boolean; minPriceRatio: string }> = [];
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
        const items: CouponWriteItem[] = computeCouponWrites(
            { code, basePrice, actionPrice, productMaxDiscount, manufacturer, category, allowLoyaltyDiscount },
            loyaltyTiers, brandLimits, categoryLimits
        );

        for (const item of items) {
            const stats = tierStats[item.tier];
            stats.total++;
            if (item.applyDiscountCoupon) stats.on++; else stats.off++;

            reportRows.push({
                code: item.code,
                tier: item.tier,
                pricelistId: item.pricelistId,
                applyDiscountCoupon: item.applyDiscountCoupon,
                minPriceRatio: item.minPriceRatio.toFixed(4)
            });
        }

        if (productCount % 2000 === 0) console.log(`...processed ${productCount} products`);
    }

    const reportPath = path.resolve(__dirname, '../../coupon-dry-run-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(reportRows, null, 2), 'utf-8');

    console.log('\n=== DRY RUN — žádný zápis do Shoptet API neproběhl ===');
    console.log(`Produktů zpracováno: ${productCount} (přeskočeno bez ceny: ${skippedNoPrice})`);
    console.log('\nPer-tier souhrn (applyDiscountCoupon):');
    for (const [tier, pricelistId] of Object.entries(ALL_PRICELISTS_MAP)) {
        const s = tierStats[tier];
        console.log(`  ${tier} (pricelist ${pricelistId}): ON=${s.on}  OFF=${s.off}  celkem=${s.total}`);
    }
    console.log(`\nPlný report (${reportRows.length} řádků) uložen do: ${reportPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
