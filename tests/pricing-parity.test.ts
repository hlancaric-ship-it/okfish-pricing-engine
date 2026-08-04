import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { EngineBuilder } from '../src/core/EngineBuilder.js';
import { CustomerTier } from '../src/core/interfaces.js';
import { calculateAllTierPrices, CsvRow } from '../cloudflare-worker/src/engine/pricing.js';
import { TIER_NAMES } from '../cloudflare-worker/src/engine/config.js';

// Proves the Worker's dependency-free pricing math and root's Decimal.js PricingEngine
// implement the SAME single business algorithm (per docs/Pricing.md), across a
// representative sweep of product profiles the two engines used to disagree on:
//  - no limit at all (plain loyalty vs action)
//  - product-level maxDiscount (was: correctly handled by root, silently IGNORED by
//    the Worker, which used to apply an unrelated purchasePrice-margin floor instead)
//  - brand limit (Apple) / category limit (Elektronika), and product-limit precedence
//    over both when several are present at once
//  - allowLoyaltyDiscount = false (was: the Worker used to compute a loyalty price
//    unconditionally, ignoring this flag entirely)
//
// 5 profiles x 10 tiers x 2 allowLoyaltyDiscount states = 100 combinations, each
// independently computed by BOTH engines and asserted equal to the cent.

interface Profile {
    name: string;
    basePrice: number;
    actionPrice?: number;
    manufacturer?: string;
    category?: string;
    maxDiscountPct?: number; // as it appears in the CSV, e.g. 25 for 25%
}

const PROFILES: Profile[] = [
    { name: 'no-limit-plain-loyalty', basePrice: 100 },
    { name: 'product-limit-with-action-price', basePrice: 28.95, actionPrice: 24.61, maxDiscountPct: 25 },
    { name: 'brand-limit-apple', basePrice: 50, manufacturer: 'Apple' },
    { name: 'category-limit-electronics', basePrice: 80, category: 'Elektronika' },
    { name: 'product-limit-overrides-brand-and-category', basePrice: 200, actionPrice: 150, manufacturer: 'Apple', category: 'Elektronika', maxDiscountPct: 8 },
    // Real incident (2026-08-04, VAGNER): action price (~18% off) steeper than the
    // product's maxDiscount cap (10%). The cap must NEVER water down an active
    // clearance/sale price — see INCIDENTS.md and DiscountLimitPolicy's SALE check.
    { name: 'action-price-steeper-than-cap', basePrice: 344.12, actionPrice: 281.67, maxDiscountPct: 10 }
];

function toWorkerRow(p: Profile, tier: string, allowLoyaltyDiscount: boolean): CsvRow {
    const row: CsvRow = {
        code: p.name,
        price: String(p.basePrice).replace('.', ','),
        applyLoyaltyDiscount: allowLoyaltyDiscount ? '1' : '0'
    };
    if (p.actionPrice !== undefined) row.actionPrice = String(p.actionPrice).replace('.', ',');
    if (p.manufacturer) row.manufacturer = p.manufacturer;
    if (p.category) row.categoryText = p.category;
    if (p.maxDiscountPct !== undefined) row.maxDiscount = String(p.maxDiscountPct);
    return row;
}

describe('Pricing parity: Worker engine vs root PricingEngine, 100 combinations', () => {
    const engine = EngineBuilder.fromConfig('src/config/policies/policy-v1.json').build();

    const cases: Array<{ profile: Profile; tier: string; allowLoyaltyDiscount: boolean }> = [];
    for (const profile of PROFILES) {
        for (const tier of TIER_NAMES) {
            for (const allowLoyaltyDiscount of [true, false]) {
                cases.push({ profile, tier, allowLoyaltyDiscount });
            }
        }
    }

    it('generates at least 100 representative combinations', () => {
        expect(cases.length).toBeGreaterThanOrEqual(100);
    });

    it.each(cases)('$profile.name / $tier / allowLoyaltyDiscount=$allowLoyaltyDiscount', ({ profile, tier, allowLoyaltyDiscount }) => {
        // --- Worker engine ---
        const workerRow = toWorkerRow(profile, tier, allowLoyaltyDiscount);
        const workerPrice = calculateAllTierPrices(workerRow)[tier].price;

        // --- Root engine ---
        const input = {
            sku: profile.name,
            basePrice: new Decimal(profile.basePrice),
            salePrice: profile.actionPrice !== undefined ? new Decimal(profile.actionPrice) : undefined,
            customerTier: tier as CustomerTier,
            allowLoyaltyDiscount,
            productMaxDiscount: profile.maxDiscountPct !== undefined ? new Decimal(profile.maxDiscountPct).dividedBy(100) : undefined,
            manufacturer: profile.manufacturer,
            category: profile.category
        };
        const result = engine.calculatePrice(input);
        const rootPrice = Number(result.finalPrice.toFixed(2));

        expect(workerPrice, `${profile.name}/${tier}/loyalty=${allowLoyaltyDiscount}: worker=${workerPrice} root=${rootPrice}`).toBe(rootPrice);
    });
});
