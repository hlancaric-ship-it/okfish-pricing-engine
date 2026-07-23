// Ported 1:1 from ../../src/config/policies/policy-v1.json and
// ../../src/core/config.ts — the single source of truth for loyalty tiers and their
// Shoptet pricelist IDs. Keep in sync if the main engine's policy ever changes.
'use strict';

const LOYALTY_TIERS = {
    ZR4: 4, ZR6: 6, ZR8: 8, ZR10: 10, ZR12: 12,
    ZR14: 14, ZR16: 16, ZR18: 18, ZR20: 20, ZR25: 25
};

const TIER_NAMES = Object.keys(LOYALTY_TIERS);

// tier name -> Shoptet pricelist ID (from src/core/config.ts)
const TIER_TO_PRICELIST_ID = {
    ZR4: 2, ZR6: 5, ZR8: 8, ZR10: 11, ZR12: 14,
    ZR14: 17, ZR16: 20, ZR18: 23, ZR20: 26, ZR25: 29
};

function determineCustomerTier(totalOrderValue) {
    if (totalOrderValue >= 10000) return 'ZR25';
    if (totalOrderValue >= 7000) return 'ZR20';
    if (totalOrderValue >= 5000) return 'ZR18';
    if (totalOrderValue >= 2000) return 'ZR16';
    if (totalOrderValue >= 1000) return 'ZR14';
    if (totalOrderValue >= 700) return 'ZR12';
    if (totalOrderValue >= 500) return 'ZR10';
    if (totalOrderValue >= 300) return 'ZR8';
    if (totalOrderValue >= 100) return 'ZR6';
    return 'ZR4';
}

module.exports = { LOYALTY_TIERS, TIER_NAMES, TIER_TO_PRICELIST_ID, determineCustomerTier };
