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

// Only the 4%-cap brands get coupon disabled everywhere (GUEST + every ZR
// tier), confirmed live 2026-08-05 -- client's final call. The ~26-brand 10%
// group (Lowrance's 4% siblings excluded) uses the NORMAL room formula
// (cap - current discount, via CouponPolicy Rule 2 + brandLimits), same as
// Delphin/Delphin BOMB/Mikado's 20%-ceiling formula just with the brand's own
// cap as ceiling instead of 20% -- confirmed live on Lowrance (a 4%-cap
// product): coupon capped exactly at -4%, never below, so the underlying
// engine logic is already correct; only these 4 brands need coupon fully off.
const ALWAYS_OFF_BRANDS = new Set(['HUMMINBIRD', 'LOWRANCE', 'NAVICO', 'SIMRAD']);

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
        const manufacturer = row['manufacturer'] || undefined;
        const manufacturerUpper = manufacturer?.trim().toUpperCase();
        // Deliberately NOT reading row['maxDiscount'] here -- same reasoning as the
        // price engine fix: that feed field is also where earlier coupon-room
        // exports wrote GUEST's computed room (e.g. "20" for any normal brand),
        // so it can no longer be trusted as a genuine per-product cap. Coupon
        // eligibility now relies solely on the curated brandLimits (policy-v1.json)
        // via computeCouponWrites' own Product->Brand->Category fallback (Product
        // level is simply never populated here anymore).
        const productMaxDiscount = undefined;
        const isAlwaysOffBrand = manufacturerUpper !== undefined && ALWAYS_OFF_BRANDS.has(manufacturerUpper);
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
            // computeCouponWrites (via brandLimits) already gives the right room for
            // EVERY brand, including GUEST: cap (or 20% default) minus whatever
            // discount already applies. For a no-action-price product this naturally
            // equals the brand's own cap (e.g. Lowrance with no action price -> room
            // = 4% - 0% = 4%, exactly the value that must stay in "Maximální povolená
            // sleva" -- confirmed live 2026-08-05, LOWRANCE id 29997). No hardcoding
            // needed for GUEST vs. tier here.
            //
            // 4%-cap brands (ALWAYS_OFF_BRANDS) are the one deliberate exception, and
            // ONLY on the ZR tiers -- client's explicit final call: no coupon there at
            // all, regardless of room. GUEST is NOT included in this override; it uses
            // the same natural room formula as everyone else.
            const tierOverrideOff = isAlwaysOffBrand && tier !== 'GUEST';
            const isEligible = !tierOverrideOff && !!item && item.applyDiscountCoupon && roomPct > 0;
            const applyCoupon = isEligible ? '1' : (tierOverrideOff ? '0' : '');
            const maxDisc = isEligible ? roomPct.toString() : '';
            if (tier === 'GUEST') {
                cols.push(applyCoupon, maxDisc);
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
