import { describe, it, expect, vi } from 'vitest';

// The Worker engine (cloudflare-worker/src/engine/pricing.ts) reads BRAND_LIMITS/
// CATEGORY_LIMITS/BRAND_SALE_DISCOUNTS/LOYALTY_TIERS as module-level constants
// imported from the REAL policy-v1.json -- they are NOT parameters the caller can
// override (only productLimits is). To test brand/category/sale-discount profiles
// in isolation (without depending on -- or polluting -- the real production policy),
// mock the config module with synthetic values and pass the IDENTICAL synthetic
// values into the desktop-app engine's `limits` argument (which does accept them
// as parameters). This guarantees both sides see the same input by construction,
// not by coincidentally matching real config.
vi.mock('../cloudflare-worker/src/engine/config.js', () => ({
    LOYALTY_TIERS: { ZR4: 4, ZR6: 6, ZR8: 8, ZR10: 10, ZR12: 12, ZR14: 14, ZR16: 16, ZR18: 18, ZR20: 20, ZR25: 25 },
    TIER_NAMES: ['ZR4', 'ZR6', 'ZR8', 'ZR10', 'ZR12', 'ZR14', 'ZR16', 'ZR18', 'ZR20', 'ZR25'],
    BRAND_LIMITS: { VAGNER: 0.10 },
    CATEGORY_LIMITS: { Elektronika: 0.08 },
    BRAND_SALE_DISCOUNTS: { MIVARDI: 0.10 },
    PRODUCT_LIMITS: {},
}));

const { calculateAllTierPrices: workerCalc, CsvRow } = await import('../cloudflare-worker/src/engine/pricing.js') as any;
const { TIER_NAMES } = await import('../cloudflare-worker/src/engine/config.js');
// desktop-app/lib/pricingEngine.js is CommonJS -- dynamic import() (not require(),
// which @typescript-eslint/no-require-imports forbids) triggers Vitest's ESM/CJS
// interop transparently, same technique used in tests/brand-sale-discounts.test.ts.
const desktopEngine = (await import('../desktop-app/lib/pricingEngine.js')) as any;

// Proves desktop-app/lib/pricingEngine.js (the manual 1:1 port used by
// xlsxProductProcessor.js, the desktop admin app's XLSX price-recalculation feature)
// produces IDENTICAL output to the Worker engine (the live, production source of
// truth) across a representative profile sweep, mirroring tests/pricing-parity.test.ts.
//
// Written 2026-08-19 after discovering the desktop-app port's resolveActiveLimit was
// missing the Product-level override entirely (only checked Brand -> Category), and
// xlsxProductProcessor.js never passed ANY limits object at all -- so the desktop
// app's price recalculation ran with brand/category/product discount caps completely
// disabled. Both fixed same day. This test exists so that kind of silent drift between
// the two engine copies gets caught by CI, not discovered by reading source months later.
interface Profile {
    name: string;
    basePrice: number;
    actionPrice?: number;
    manufacturer?: string; // must be a key in the mocked BRAND_LIMITS/BRAND_SALE_DISCOUNTS above
    category?: string; // must be a key in the mocked CATEGORY_LIMITS above
    productLimitPct?: number; // ratio*100, e.g. 10 for a 10% product-level cap
}

const PROFILES: Profile[] = [
    { name: 'no-limit-plain-loyalty', basePrice: 100 },
    { name: 'product-limit-with-action-price', basePrice: 28.95, actionPrice: 24.61, productLimitPct: 25 },
    { name: 'brand-limit', basePrice: 50, manufacturer: 'VAGNER' },
    { name: 'category-limit', basePrice: 80, category: 'Elektronika' },
    {
        name: 'product-limit-overrides-brand-and-category',
        basePrice: 200,
        actionPrice: 150,
        manufacturer: 'VAGNER',
        category: 'Elektronika',
        productLimitPct: 8,
    },
    // Real incident (2026-08-04, VAGNER): action/sale price steeper than the cap must
    // stay authoritative, never watered down by the cap-floor. See INCIDENTS.md.
    { name: 'action-price-steeper-than-cap', basePrice: 344.12, actionPrice: 281.67, productLimitPct: 10 },
    // Celoroční brandová akční cena (brandSaleDiscounts) -- synthesizes an actionPrice
    // when the product doesn't already have one of its own.
    { name: 'brand-sale-discount-synthesizes-action-price', basePrice: 120, manufacturer: 'MIVARDI' },
    // No-op action price (>= basePrice, leftover from an ended promotion) must be
    // ignored by both engines identically.
    { name: 'noop-action-price-equal-to-base', basePrice: 100, actionPrice: 100 },
];

function toRow(p: Profile, allowLoyaltyDiscount: boolean) {
    const row: Record<string, string> = {
        code: p.name,
        price: String(p.basePrice).replace('.', ','),
        applyLoyaltyDiscount: allowLoyaltyDiscount ? '1' : '0',
    };
    if (p.actionPrice !== undefined) row.actionPrice = String(p.actionPrice).replace('.', ',');
    if (p.manufacturer) row.manufacturer = p.manufacturer;
    if (p.category) row.categoryText = p.category;
    return row;
}

describe('desktop-app pricingEngine.js matches the Worker engine (cross-engine parity)', () => {
    for (const allowLoyaltyDiscount of [true, false]) {
        for (const profile of PROFILES) {
            it(`"${profile.name}" (allowLoyaltyDiscount=${allowLoyaltyDiscount}) — identical price on every tier`, () => {
                const row = toRow(profile, allowLoyaltyDiscount);
                const productLimits = profile.productLimitPct !== undefined ? { [profile.name]: profile.productLimitPct / 100 } : {};

                const workerResult = workerCalc(row, productLimits);

                // Same synthetic brand/category/sale-discount maps as the mocked Worker
                // config above -- both engines see byte-identical inputs.
                const desktopResult = desktopEngine.calculateAllTierPrices(row, {
                    productLimits,
                    brandLimits: { VAGNER: 0.10 },
                    categoryLimits: { Elektronika: 0.08 },
                    brandSaleDiscounts: { MIVARDI: 0.10 },
                });

                for (const tier of TIER_NAMES) {
                    expect(desktopResult[tier].price, `tier ${tier} price`).toBeCloseTo(workerResult[tier].price, 2);
                    expect(desktopResult[tier].usedActionPrice, `tier ${tier} usedActionPrice`).toBe(workerResult[tier].usedActionPrice);
                }
            });
        }
    }

    it('regression: product-level cap is respected by the desktop engine (was silently ignored before 2026-08-19)', () => {
        // A customer on ZR25 (25% raw loyalty discount) with a real 10% product cap
        // must be clamped down to 10%, not get the full 25% off -- the exact bug found
        // live in xlsxProductProcessor.js (calculateAllTierPrices(row) called with no
        // limits argument at all).
        const row = { code: '101821', price: '1000' };
        const result = desktopEngine.calculateAllTierPrices(row, { productLimits: { '101821': 0.10 } });
        expect(result.ZR25.price).toBe(900); // 1000 * (1 - 0.10), NOT 750 (1000 * (1 - 0.25))
    });
});
