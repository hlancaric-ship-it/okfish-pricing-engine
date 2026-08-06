/**
 * Worker Mini Pricing Engine
 *
 * Self-contained, no Decimal.js, no Node.js imports.
 * Uses native JS number arithmetic with rounding.
 *
 * Business rules — mirrors root's PricingEngine (src/core/PricingEngine.ts +
 * src/policies/{HighestDiscountPolicy,DiscountLimitPolicy}.ts) exactly, per
 * docs/Pricing.md:
 *  1. HighestDiscount: pick whichever is lower — action price OR loyalty-discounted price
 *  2. DiscountLimit:   hierarchical fallback — product-level `maxDiscount` (CSV) overrides
 *                      brand limit overrides category limit. The active limit caps how
 *                      far the price may drop below basePrice * (1 - limit). This is a
 *                      *discount-percentage* cap, not a purchase-price margin floor — an
 *                      earlier version of this file used a `purchasePrice * (1 + margin)`
 *                      floor keyed off a `marza_v_percentach` field that doesn't exist
 *                      anywhere in the real feed (it silently always defaulted to 20%,
 *                      and the actually-populated `maxDiscount` column was never read at
 *                      all). See tests/pricing-parity.test.ts for the cross-engine proof.
 *  3. Rounding:        round to 2 decimal places
 */

import { LOYALTY_TIERS, TIER_NAMES, BRAND_LIMITS, CATEGORY_LIMITS, PRODUCT_LIMITS } from './config';

export interface CsvRow {
    [key: string]: string;
}

export interface TierPrice {
    price: number;
    /** action price from source, if used as the best deal */
    usedActionPrice: boolean;
}

export type AllTierPrices = Record<string, TierPrice>;

/** Parse a price string — handles comma decimal separators */
function parsePrice(val: string | undefined): number | undefined {
    if (!val || val.trim() === '') return undefined;
    const normalized = val.replace(',', '.').replace(/\s/g, '');
    const n = parseFloat(normalized);
    return isNaN(n) ? undefined : n;
}

/** Round to 2 decimal places */
function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

// Applies a "keep (100-pct)% of basePrice" calculation using integer-cents-safe math.
// Plain `basePrice * (1 - pct / 100)` is vulnerable to binary floating-point error —
// e.g. 4.3 * 0.75 evaluates to 3.2249999999999996 (not the exact 3.225), which then
// rounds DOWN to 3.22 instead of the correct 3.23, silently undercharging by a cent on
// every price ending in exactly .x25/.x75 at a 25%-style discount. Converting basePrice
// to integer cents first keeps the multiplication exact (product of two integers), so
// the final division/round lands on the true decimal value instead of its float ghost.
function applyPercent(basePrice: number, pct: number): number {
    const baseCents = Math.round(basePrice * 100);
    return Math.round(baseCents * (100 - pct) / 100) / 100;
}

// PRICE-cap resolution deliberately does NOT read row.maxDiscount from the feed.
// That field is also where the coupon-fields export writes each product's GUEST
// coupon "room" (e.g. 20% for any normal, non-capped brand) -- confirmed live
// 2026-08-05 on a non-branded product (code 106645) where a leftover room value
// of "20" wrongly clamped ZR25's real 25% loyalty discount down to 20%. Coupon
// eligibility (computeCouponWrites/CouponPolicy) is correct and untouched by
// this -- only the underlying tier PRICE must ignore that field and trust only
// the curated BRAND_LIMITS/CATEGORY_LIMITS (policy-v1.json), the one source of
// truth for a genuine, intentional per-brand discount ceiling.
function resolveActiveLimit(row: CsvRow): number | undefined {
    // Product-level override always wins -- matches root's DiscountLimitPolicy
    // Product -> Brand -> Category priority (added 2026-08-06, see config.ts
    // PRODUCT_LIMITS comment for why this was missing before).
    const code = row['code'];
    if (code && PRODUCT_LIMITS[code] !== undefined) return PRODUCT_LIMITS[code];

    const manufacturer = row['manufacturer'];
    if (manufacturer && BRAND_LIMITS[manufacturer] !== undefined) return BRAND_LIMITS[manufacturer];

    const category = row['categoryText'];
    if (category && CATEGORY_LIMITS[category] !== undefined) return CATEGORY_LIMITS[category];

    return undefined;
}

// Same interpretation as src/cli/generate.ts's `applyLoyalty` (the tested, working CSV
// pipeline): missing/absent defaults to allowed, only an explicit falsy-looking value
// turns it off. Root's PricingEngine only computes a loyalty price at all when this is
// true — computing it unconditionally (as an earlier version of this file did) would
// discount products explicitly marked as loyalty-discount-ineligible.
function resolveAllowLoyaltyDiscount(row: CsvRow): boolean {
    const val = row['applyLoyaltyDiscount'];
    return val === "1" || val === "true" || val === "yes" || val === undefined;
}

/**
 * Calculate all loyalty tier prices for a single CSV row.
 * Returns a map of tier → { price, usedActionPrice }.
 */
export function calculateAllTierPrices(row: CsvRow): AllTierPrices {
    const basePrice = parsePrice(row['price'] || row['priceVat'] || row['standardPrice']);
    if (!basePrice || basePrice <= 0) {
        // No valid base price — return base for all tiers
        const fallback = parsePrice(row['price']) ?? 0;
        const result: AllTierPrices = {};
        for (const tier of TIER_NAMES) {
            result[tier] = { price: round2(fallback), usedActionPrice: false };
        }
        return result;
    }

    let actionPrice = parsePrice(row['actionPrice'] || row['salePrice']);
    // An "action price" that isn't actually lower than the base price is a
    // no-op leftover (e.g. a promotion that ended but the field wasn't
    // cleared) -- confirmed live 2026-08-05 on LOWRANCE code 111139
    // (actionPrice == price == 1167.20, blocking all loyalty/cap pricing).
    // Treat it as "no action" so it can't override the cap-floor rule below.
    if (actionPrice !== undefined && actionPrice >= basePrice) actionPrice = undefined;
    const allowLoyaltyDiscount = resolveAllowLoyaltyDiscount(row);
    const activeLimit = resolveActiveLimit(row);
    const minAllowedPrice = activeLimit !== undefined ? applyPercent(basePrice, activeLimit * 100) : 0;

    const result: AllTierPrices = {};

    for (const tier of TIER_NAMES) {
        const discountPct = LOYALTY_TIERS[tier] ?? 0;

        // Loyalty price = basePrice * (1 - discount%) — only when loyalty is allowed.
        const loyaltyPrice = allowLoyaltyDiscount ? applyPercent(basePrice, discountPct) : undefined;

        // Pick best (lowest) between loyalty and action price; if neither applies,
        // the price stays at basePrice (matches root's BasePricePolicy default).
        let bestPrice: number = basePrice;
        let usedAction = false;

        if (minAllowedPrice > 0 && actionPrice !== undefined) {
            // A cap is active AND the product has its own sale/action price — that
            // sale price is authoritative: neither raised by the cap-floor below,
            // nor overridden by a steeper loyalty-tier discount. Explicit client
            // requirement — see INCIDENTS.md ("2026-08-04 VAGNER" entry).
            bestPrice = actionPrice;
            usedAction = true;
        } else if (actionPrice !== undefined && loyaltyPrice !== undefined) {
            if (actionPrice < loyaltyPrice) { bestPrice = actionPrice; usedAction = true; }
            else { bestPrice = loyaltyPrice; }
        } else if (actionPrice !== undefined) {
            bestPrice = actionPrice;
            usedAction = true;
        } else if (loyaltyPrice !== undefined) {
            bestPrice = loyaltyPrice;
        }

        // Enforce the discount limit floor — but NEVER against an active action/sale
        // price (handled above already; this only fires for loyalty-only prices).
        if (!usedAction && minAllowedPrice > 0 && bestPrice < minAllowedPrice) {
            bestPrice = minAllowedPrice;
        }

        result[tier] = { price: round2(bestPrice), usedActionPrice: usedAction };
    }

    return result;
}
