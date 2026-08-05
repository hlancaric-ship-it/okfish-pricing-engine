// Ported 1:1 from ../../cloudflare-worker/src/engine/pricing.ts (the same engine used
// by the production Worker and CLI) — including the 2026-07-23 integer-cents rounding
// fix (applyPercent) for the binary-floating-point bug that silently undercharged
// prices ending in .x25/.x75.
'use strict';

const { LOYALTY_TIERS, TIER_NAMES } = require('./policy');

function parsePrice(val) {
    if (!val || String(val).trim() === '') return undefined;
    const normalized = String(val).replace(',', '.').replace(/\s/g, '');
    const n = parseFloat(normalized);
    return isNaN(n) ? undefined : n;
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

// Integer-cents-safe percentage math — avoids binary float artifacts like
// 4.3 * 0.75 evaluating to 3.2249999999999996 instead of the exact 3.225.
function applyPercent(basePrice, pct) {
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
// the curated brandLimits/categoryLimits (policy-v1.json), which are the one
// source of truth for a genuine, intentional per-brand discount ceiling.
function resolveActiveLimit(row, brandLimits, categoryLimits) {
    const manufacturer = row.manufacturer;
    if (manufacturer && brandLimits && brandLimits[manufacturer] !== undefined) return brandLimits[manufacturer];

    const category = row.categoryText;
    if (category && categoryLimits && categoryLimits[category] !== undefined) return categoryLimits[category];

    return undefined;
}

function resolveAllowLoyaltyDiscount(row) {
    const val = row.applyLoyaltyDiscount;
    return val === '1' || val === 'true' || val === 'yes' || val === undefined;
}

/**
 * @param {Record<string,string>} row
 * @param {{brandLimits?: Record<string,number>, categoryLimits?: Record<string,number>}} [limits]
 * @returns {Record<string, {price: number, usedActionPrice: boolean}>}
 */
function calculateAllTierPrices(row, limits) {
    limits = limits || {};
    const basePrice = parsePrice(row.price || row.priceVat || row.standardPrice);

    if (!basePrice || basePrice <= 0) {
        const fallback = parsePrice(row.price) ?? 0;
        const result = {};
        for (const tier of TIER_NAMES) result[tier] = { price: round2(fallback), usedActionPrice: false };
        return result;
    }

    let actionPrice = parsePrice(row.actionPrice || row.salePrice);
    // A no-op "action price" (not actually lower than the base price) is a
    // leftover from an ended promotion whose field wasn't cleared -- treat it
    // as no action so it can't override the cap-floor rule below. Confirmed
    // live 2026-08-05 (LOWRANCE code 111139).
    if (actionPrice !== undefined && actionPrice >= basePrice) actionPrice = undefined;
    const allowLoyaltyDiscount = resolveAllowLoyaltyDiscount(row);
    const activeLimit = resolveActiveLimit(row, limits.brandLimits, limits.categoryLimits);
    const minAllowedPrice = activeLimit !== undefined ? applyPercent(basePrice, activeLimit * 100) : 0;

    const result = {};

    for (const tier of TIER_NAMES) {
        const discountPct = LOYALTY_TIERS[tier] ?? 0;
        const loyaltyPrice = allowLoyaltyDiscount ? applyPercent(basePrice, discountPct) : undefined;

        let bestPrice = basePrice;
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

module.exports = { calculateAllTierPrices, parsePrice };
