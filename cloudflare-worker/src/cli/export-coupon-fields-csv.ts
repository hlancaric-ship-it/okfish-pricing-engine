// Generates a Shoptet-import-ready CSV of coupon fields (discountCoupon +
// minPriceRatio, expressed as applyDiscountCoupon/maxDiscount columns) for
// EVERY pricelist including GUEST — reuses the exact same tested
// computeCouponWrites() logic as sync-coupon-fields-diff.ts, just outputs a
// file for MANUAL import instead of writing live via API.
//
// Unlike the automated cron (which hard-refuses to write GUEST via the API
// path, per Law #1 / BUG#3 protection), this export INCLUDES a correctly
// computed GUEST value — computeCouponWrites treats GUEST as a 0%-loyalty
// tier and applies the exact same rules as any other tier, so it's not a
// "mirror of ZR4" but GUEST's own correct value. Client reviews/imports
// this manually, so the automatic-cron danger (destructive overwrite on
// every run without review) doesn't apply here.
//
// Usage: npx tsx src/cli/export-coupon-fields-csv.ts
import * as fs from 'fs';
import * as path from 'path';
import Decimal from 'decimal.js';
import { CsvParserStream } from '../csv/csv-parser';
import { computeCouponWrites } from '../coupon/compute-coupon-writes';
import { ALL_PRICELISTS_MAP } from '../coupon/tier-pricelist-map';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { calculateAllTierPrices } = require('../../../desktop-app/lib/pricingEngine.js');

// Brands with a real, hard discount ceiling (~30 brands at 10%, plus
// Lowrance/Humminbird/Simrad/Navico at 4%) -- confirmed live 2026-08-05: for
// these, "Slevový kupón" must be OFF everywhere (GUEST + every ZR tier), no
// exceptions, no partial room -- unlike Delphin/Delphin BOMB/Mikado (flat
// action-price brands with NO cap), where coupon room is computed normally.
// Most of these already carry their real maxDiscount value in the feed from
// the earlier brand-cap CSV import; MIVARDI is listed explicitly here because
// it was reclassified into this hard-cap group after that import already ran,
// so the feed doesn't reflect it yet.
const HARD_CAP_BRAND_OVERRIDE: Record<string, number> = { MIVARDI: 10 };

function loadRootEnv() {
    const envPath = path.resolve(__dirname, '../../../.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
}
loadRootEnv();

function parseNumber(val: string | undefined): Decimal | undefined {
    if (!val || val.trim() === '') return undefined;
    const normalized = val.replace(',', '.').replace(/\s/g, '');
    const n = new Decimal(normalized);
    return n.isNaN() ? undefined : n;
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
        categoryLimits: toDecimalMap(policy.categoryLimits),
    };
}

function resolveAllowLoyaltyDiscount(row: Record<string, string>): boolean {
    const val = row['applyLoyaltyDiscount'];
    return val === '1' || val === 'true' || val === 'yes' || val === undefined;
}

async function main() {
    const feedUrl = process.env.MASTER_FEED_URL;
    if (!feedUrl) throw new Error('MASTER_FEED_URL not set in .env');

    const { loyaltyTiers, brandLimits, categoryLimits } = loadPolicyConfig();
    // calculateAllTierPrices (JS engine) wants plain numbers, not Decimal.
    const plainBrandLimits: Record<string, number> = {};
    for (const [k, v] of Object.entries(brandLimits)) plainBrandLimits[k] = v.toNumber();
    const plainCategoryLimits: Record<string, number> = {};
    for (const [k, v] of Object.entries(categoryLimits)) plainCategoryLimits[k] = v.toNumber();
    const priceLimits = { brandLimits: plainBrandLimits, categoryLimits: plainCategoryLimits };

    console.log('Fetching master feed...');
    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) throw new Error(`Master feed fetch failed: HTTP ${res.status}`);

    const outPath = path.resolve(process.cwd(), '../coupon_fields_import.csv');
    const out = fs.createWriteStream(outPath);

    // Header: code, pairCode, then per-tier columns. GUEST uses the
    // unprefixed applyDiscountCoupon/maxDiscount names (matches how the
    // Shoptet export represents pricelist 1), other tiers use
    // pricelist:<id>:applyDiscountCoupon / pricelist:<id>:maxDiscount.
    const tierOrder = Object.entries(ALL_PRICELISTS_MAP); // [ [ZR4,2], ..., [GUEST,1] ]
    const headerCols = ['code', 'pairCode'];
    for (const [tier, pricelistId] of tierOrder) {
        if (tier === 'GUEST') {
            headerCols.push('applyDiscountCoupon', 'maxDiscount');
        } else {
            // Shoptet's import REQUIRES pricelist:<id>:price to be present for
            // ANY per-pricelist column on that pricelist to be accepted at all
            // (confirmed live 2026-08-05 — without it every pricelist:X:* column
            // is silently skipped with a warning, even though export uses this
            // exact same column set). We include the engine's own correctly
            // computed price here — same value it already has — purely to
            // satisfy this requirement, never to change it.
            headerCols.push(`pricelist:${pricelistId}:price`, `pricelist:${pricelistId}:applyDiscountCoupon`, `pricelist:${pricelistId}:maxDiscount`);
        }
    }
    out.write(headerCols.join(';') + '\n');

    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();

    let scanned = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        const code = row['code'];
        if (!code) continue;

        const basePrice = parseNumber(row['price'] || row['standardPrice']);
        if (!basePrice || basePrice.lessThanOrEqualTo(0)) continue;

        const actionPrice = parseNumber(row['actionPrice']);
        const maxDiscountPct = parseNumber(row['maxDiscount']);
        const productMaxDiscount = maxDiscountPct !== undefined ? maxDiscountPct.dividedBy(100) : undefined;
        const manufacturer = row['manufacturer'] || undefined;
        const manufacturerUpper = manufacturer?.trim().toUpperCase();
        // Hard cap = product's own feed maxDiscount is set (the ~30-brand list
        // already carries this from the earlier import) OR it's in the explicit
        // override map (MIVARDI). Either way: no coupon, anywhere, ever.
        const isHardCapBrand = (maxDiscountPct !== undefined && maxDiscountPct.lessThan(20))
            || (manufacturerUpper !== undefined && HARD_CAP_BRAND_OVERRIDE[manufacturerUpper] !== undefined);
        const category = row['categoryText'] || undefined;
        const allowLoyaltyDiscount = resolveAllowLoyaltyDiscount(row);

        scanned++;
        const items = computeCouponWrites(
            { code, basePrice, actionPrice, productMaxDiscount, manufacturer, category, allowLoyaltyDiscount },
            loyaltyTiers, brandLimits, categoryLimits,
        );
        const byTier = new Map(items.map((i) => [i.tier, i]));
        const tierPrices = calculateAllTierPrices(row, priceLimits);

        const cols = [code, row['pairCode'] || ''];
        for (const [tier] of tierOrder) {
            const item = byTier.get(tier);
            // No coupon room (or no item at all) -> leave BOTH cells empty, never "0".
            // Shoptet distinguishes "checkbox unchecked / field blank" (no cap, no
            // restriction) from "checked with value 0" (blocks all discount) -- a
            // literal "0" here would wrongly write the latter. Confirmed live
            // 2026-08-05: this exact mistake corrupted Delphin/Mikado's caps.
            const roomPct = item ? Math.round((1 - Number(item.minPriceRatio.toFixed(4))) * 100) : 0;
            const isEligible = !isHardCapBrand && !!item && item.applyDiscountCoupon && roomPct > 0;
            const applyCoupon = isEligible ? '1' : (isHardCapBrand ? '0' : '');
            const maxDisc = isEligible ? roomPct.toString() : '';
            if (tier === 'GUEST') {
                // GUEST's "Maximální povolená sleva" field, when a REAL room value is
                // written there, means "how much MORE the coupon may take off on top
                // of the current price" -- NOT an absolute ceiling. Confirmed live
                // 2026-08-05 by the client's own manual test on a Mivardi product
                // (10% flat action price + "Maximální povolená sleva"=10% checked +
                // "Slevový kupón" checked => coupon correctly adds another 10%,
                // 20% total). So GUEST gets the SAME Rule-5-computed room as any
                // other tier for normal/flat brands.
                //
                // Hard-cap brands are different again: confirmed live 2026-08-05 on
                // LOWRANCE (code 65782) -- "Slevový kupón" is a separate ON/OFF gate
                // from "Maximální povolená sleva". If it's OFF, the coupon field shows
                // "no discount available" and GUEST can't even try a code (and without
                // any coupon/action price, GUEST sees the full undiscounted price --
                // "Maximální povolená sleva" is only a CEILING on other discounts, not
                // a discount by itself). With it ON, a coupon can be entered but the
                // price still can never drop below the existing cap floor (verified:
                // -20% coupon on a 4%-cap product stopped exactly at -4%, not lower).
                // So for hard-cap brands GUEST must have "Slevový kupón" ON (so the
                // coupon field actually works) with NO room value written (the real
                // cap is a separate field/import and isn't touched here).
                const guestApplyCoupon = isHardCapBrand ? '1' : applyCoupon;
                const guestMaxDisc = isHardCapBrand ? '' : maxDisc;
                cols.push(guestApplyCoupon, guestMaxDisc);
            } else {
                const price = tierPrices[tier] ? String(tierPrices[tier].price) : '';
                cols.push(price, applyCoupon, maxDisc);
            }
        }
        out.write(cols.join(';') + '\n');

        if (scanned % 4000 === 0) console.log(`...zpracováno ${scanned}`);
    }

    out.end();
    console.log(`\nHOTOVO. Zpracováno ${scanned} produktů. Soubor: ${outPath}`);
}

main().catch((e) => { console.error('CHYBA:', e); process.exit(1); });
