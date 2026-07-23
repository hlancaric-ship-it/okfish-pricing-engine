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

function resolveActiveLimit(row, brandLimits, categoryLimits) {
    const productMaxDiscountPct = parsePrice(row.maxDiscount);
    if (productMaxDiscountPct !== undefined) return productMaxDiscountPct / 100;

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

    const actionPrice = parsePrice(row.actionPrice || row.salePrice);
    const allowLoyaltyDiscount = resolveAllowLoyaltyDiscount(row);
    const activeLimit = resolveActiveLimit(row, limits.brandLimits, limits.categoryLimits);
    const minAllowedPrice = activeLimit !== undefined ? applyPercent(basePrice, activeLimit * 100) : 0;

    const result = {};

    for (const tier of TIER_NAMES) {
        const discountPct = LOYALTY_TIERS[tier] ?? 0;
        const loyaltyPrice = allowLoyaltyDiscount ? applyPercent(basePrice, discountPct) : undefined;

        let bestPrice = basePrice;
        let usedAction = false;

        if (actionPrice !== undefined && loyaltyPrice !== undefined) {
            if (actionPrice < loyaltyPrice) { bestPrice = actionPrice; usedAction = true; }
            else { bestPrice = loyaltyPrice; }
        } else if (actionPrice !== undefined) {
            bestPrice = actionPrice;
            usedAction = true;
        } else if (loyaltyPrice !== undefined) {
            bestPrice = loyaltyPrice;
        }

        if (minAllowedPrice > 0 && bestPrice < minAllowedPrice) {
            bestPrice = minAllowedPrice;
        }

        result[tier] = { price: round2(bestPrice), usedActionPrice: usedAction };
    }

    return result;
}

module.exports = { calculateAllTierPrices, parsePrice };
