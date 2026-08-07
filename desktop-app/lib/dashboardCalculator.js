'use strict';

// Theoretical, catalog-wide snapshot ("kdyby se celý katalog prodal při současných
// pravidlech") -- not based on real orders. Mirrors the same Product -> Brand ->
// Category fallback hierarchy used everywhere else in the pricing engine (see
// resolveEffectiveLimit in cloudflare-worker/src/coupon/compute-coupon-writes.ts)
// so the numbers here match what the engine would actually apply.
function resolveEffectiveLimitPct(product, policies) {
    if (product.code in policies.productOverrides) return policies.productOverrides[product.code];
    if (policies.zeroDiscount.includes(product.code)) return 0;
    if (product.code in policies.clearance) {
        const entry = policies.clearance[product.code];
        return typeof entry === 'number' ? entry : entry.pct;
    }
    if (product.brand && product.brand in policies.brandLimits) return policies.brandLimits[product.brand] * 100;
    if (product.category && product.category in policies.categoryLimits) return policies.categoryLimits[product.category] * 100;
    return null; // no rule at all -- excluded from the discount-€ total, only counted separately
}

function computeDashboard(catalog, policies) {
    let totalDiscountEur = 0;
    let totalStandardEur = 0;
    let totalMarginEur = 0;
    let totalSellEur = 0;
    let productsWithRule = 0;
    let productsWithPurchasePrice = 0;

    for (const product of catalog.products) {
        const limitPct = resolveEffectiveLimitPct(product, policies);
        if (limitPct === null) continue;

        productsWithRule++;
        const standardPrice = product.standardPrice || 0;
        const sellPrice = standardPrice * (1 - limitPct / 100);
        const discountEur = standardPrice - sellPrice;

        totalStandardEur += standardPrice;
        totalDiscountEur += discountEur;
        totalSellEur += sellPrice;

        if (product.purchasePrice > 0) {
            productsWithPurchasePrice++;
            totalMarginEur += sellPrice - product.purchasePrice;
        }
    }

    const overallDiscountPct = totalStandardEur > 0 ? (totalDiscountEur / totalStandardEur) * 100 : 0;
    const overallMarginPct = totalSellEur > 0 ? (totalMarginEur / totalSellEur) * 100 : 0;

    return {
        totalDiscountEur,
        overallDiscountPct,
        totalMarginEur,
        overallMarginPct,
        productsWithRule,
        productsWithPurchasePrice,
        totalCatalogProducts: catalog.products.length,
        breakdown: {
            productOverrides: Object.keys(policies.productOverrides).length,
            zeroDiscount: policies.zeroDiscount.length,
            clearance: Object.keys(policies.clearance).length,
            brandLimits: Object.keys(policies.brandLimits).length,
            categoryLimits: Object.keys(policies.categoryLimits).length
        }
    };
}

module.exports = { computeDashboard };
