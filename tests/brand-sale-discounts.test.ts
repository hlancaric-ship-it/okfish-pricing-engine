import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { calculateAllTierPrices, CsvRow } from '../cloudflare-worker/src/engine/pricing.js';
import { BRAND_SALE_DISCOUNTS, BRAND_LIMITS, TIER_NAMES } from '../cloudflare-worker/src/engine/config.js';
import { calculateProductsPricing } from '../cloudflare-worker/src/shoptet-api/pricing-bridge.js';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const desktopPricingEngine = require('../desktop-app/lib/pricingEngine.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const policyRaw = require('../src/config/policies/policy-v1.json');

// Covers INC-011-adjacent follow-up: policy-v1.json's brandSaleDiscounts (a
// permanent, year-round brand-wide action price) is a COMPLETELY SEPARATE
// concept from brandLimits (a discount ceiling) -- see
// docs/CORE_LOGIC_AND_VALIDATION.md and the "Rule Drift" investigation this
// followed. These tests exist to prove that separation holds mechanically,
// not just by convention/comment, across every place that reads policy-v1.json:
// the Worker engine (engine/pricing.ts, powers the live badge endpoint), the
// real production write path (shoptet-api/pricing-bridge.ts, called by
// sync-orchestrator.ts every 15 minutes), and the desktop app's 1:1-ported
// pricingEngine.js.

describe('policy-v1.json: brandSaleDiscounts config', () => {
    it('has exactly the four confirmed brand rules', () => {
        expect(BRAND_SALE_DISCOUNTS['DELPHIN']).toBe(0.15);
        expect(BRAND_SALE_DISCOUNTS['DELPHIN BOMB']).toBe(0.15);
        expect(BRAND_SALE_DISCOUNTS['MIVARDI']).toBe(0.10);
        expect(BRAND_SALE_DISCOUNTS['MIKADO']).toBe(0.09);
    });

    it('DELPHIN, DELPHIN BOMB and MIKADO have NO corresponding brandLimits (maxDiscount) entry', () => {
        // The single most important assertion in this file: a brandSaleDiscount
        // must never be silently treated as a discount cap. If someone "helpfully"
        // added a matching brandLimits entry for these three brands, this fails.
        expect(BRAND_LIMITS['DELPHIN']).toBeUndefined();
        expect(BRAND_LIMITS['DELPHIN BOMB']).toBeUndefined();
        expect(BRAND_LIMITS['MIKADO']).toBeUndefined();
    });

    it('MIVARDI intentionally has BOTH a brandSaleDiscount and a brandLimit, independently declared', () => {
        expect(BRAND_SALE_DISCOUNTS['MIVARDI']).toBe(0.10);
        expect(BRAND_LIMITS['MIVARDI']).toBe(0.10);
        // Proves they're two separate JSON keys agreeing on a number, not one
        // derived from the other -- flip brandLimits.MIVARDI in policy-v1.json
        // to any other value and this still passes as long as both keys exist.
        expect(policyRaw.brandSaleDiscounts).not.toBe(policyRaw.brandLimits);
    });
});

describe('Worker engine (engine/pricing.ts): brandSaleDiscounts as a synthesized actionPrice', () => {
    function row(overrides: Partial<CsvRow> & { manufacturer?: string }): CsvRow {
        return { code: 'TEST', price: '100', ...overrides } as CsvRow;
    }

    it('DELPHIN (new product, no existing actionPrice): ZR4 (4% loyalty) gets the deeper -15% sale price', () => {
        const result = calculateAllTierPrices(row({ manufacturer: 'DELPHIN' }));
        expect(result['ZR4'].price).toBe(85);
        expect(result['ZR4'].usedActionPrice).toBe(true);
    });

    it('DELPHIN: ZR25 (25% loyalty, deeper than the 15% sale) is NOT capped at 15% -- proves brandSaleDiscount is a baseline, not a ceiling', () => {
        const result = calculateAllTierPrices(row({ manufacturer: 'DELPHIN' }));
        expect(result['ZR25'].price).toBe(75); // 25% loyalty wins, deeper than the 15% floor
        expect(result['ZR25'].usedActionPrice).toBe(false);
    });

    it('DELPHIN BOMB (exact manufacturer string, space not underscore/plural): also -15%', () => {
        const result = calculateAllTierPrices(row({ manufacturer: 'DELPHIN BOMB' }));
        expect(result['ZR4'].price).toBe(85);
    });

    it('MIKADO: -9% baseline, ZR4 (4%) gets the deeper sale price, ZR25 (25%) is not capped at 9%', () => {
        const result = calculateAllTierPrices(row({ manufacturer: 'MIKADO' }));
        expect(result['ZR4'].price).toBe(91);
        expect(result['ZR25'].price).toBe(75);
    });

    it('MIVARDI: brandLimit (10%) makes the -10% sale price authoritative on EVERY tier, including ZR25', () => {
        const result = calculateAllTierPrices(row({ manufacturer: 'MIVARDI' }));
        for (const tier of TIER_NAMES) {
            expect(result[tier].price).toBe(90); // never deeper than -10%, never shallower
            expect(result[tier].usedActionPrice).toBe(true);
        }
    });

    it('a product of an unrelated brand is completely unaffected (plain loyalty pricing, no synthesized action price)', () => {
        const result = calculateAllTierPrices(row({ manufacturer: 'SOME_OTHER_BRAND' }));
        expect(result['ZR4'].price).toBe(96); // 4% loyalty only
        expect(result['ZR4'].usedActionPrice).toBe(false);
        expect(result['ZR25'].price).toBe(75); // 25% loyalty only
    });

    it('a product with NO manufacturer at all is unaffected (no crash, no synthesis)', () => {
        const result = calculateAllTierPrices(row({}));
        expect(result['ZR4'].price).toBe(96);
    });

    it('an EXISTING product of a brand-sale brand that already has its own (different) action price keeps that price -- brandSaleDiscounts never overwrites a real per-product sale', () => {
        const result = calculateAllTierPrices(row({ manufacturer: 'DELPHIN', actionPrice: '70' }));
        expect(result['ZR4'].price).toBe(70); // the product's own 30%-off sale, not the 15% brand baseline
        expect(result['ZR25'].price).toBe(70); // still deeper than 25% loyalty (75), so action price wins
    });
});

describe('Production write path (shoptet-api/pricing-bridge.ts): calculateProductsPricing', () => {
    const pricelists = TIER_NAMES.map((name, i) => ({ name, id: i + 1 }));

    it('a brand-new DELPHIN product (no actionPrice yet) gets brandSaleActionPrice = -15% flagged for writing', () => {
        const { results } = calculateProductsPricing(
            [{ code: 'NEW-DELPHIN-1', basePrice: 100, manufacturer: 'DELPHIN' }],
            pricelists
        );
        expect(results[0].brandSaleActionPrice).toBe('85.00');
        expect(results[0].prices['ZR25']).toBe('75.0000'); // 25% loyalty still wins on ZR25
    });

    it('a brand-new MIVARDI product gets brandSaleActionPrice = -10%, authoritative on every tier (matching its brandLimit)', () => {
        const { results } = calculateProductsPricing(
            [{ code: 'NEW-MIVARDI-1', basePrice: 100, manufacturer: 'MIVARDI' }],
            pricelists
        );
        expect(results[0].brandSaleActionPrice).toBe('90.00');
        for (const tier of TIER_NAMES) {
            expect(results[0].prices[tier]).toBe('90.0000');
        }
    });

    it('a product that ALREADY has its own actionPrice is left alone -- brandSaleActionPrice is not set, existing behavior unchanged', () => {
        const { results } = calculateProductsPricing(
            [{ code: 'EXISTING-DELPHIN-1', basePrice: 100, actionPrice: 70, manufacturer: 'DELPHIN' }],
            pricelists
        );
        expect(results[0].brandSaleActionPrice).toBeUndefined();
        expect(results[0].prices['ZR4']).toBe('70.0000');
    });

    it('a product of an unrelated brand is completely unaffected', () => {
        const { results } = calculateProductsPricing(
            [{ code: 'OTHER-BRAND-1', basePrice: 100, manufacturer: 'SOME_OTHER_BRAND' }],
            pricelists
        );
        expect(results[0].brandSaleActionPrice).toBeUndefined();
        expect(results[0].prices['ZR4']).toBe('96.0000');
    });
});

describe('Cross-engine parity: Worker vs production write path vs desktop app, for all 4 brands', () => {
    const brands = ['DELPHIN', 'DELPHIN BOMB', 'MIVARDI', 'MIKADO'];
    const pricelists = TIER_NAMES.map((name, i) => ({ name, id: i + 1 }));

    it.each(brands)('%s: Worker engine.pricing.ts and pricing-bridge.ts agree on every tier', (manufacturer) => {
        const workerRow: CsvRow = { code: 'PARITY', price: '100', manufacturer };
        const workerResult = calculateAllTierPrices(workerRow);

        const { results } = calculateProductsPricing(
            [{ code: 'PARITY', basePrice: 100, manufacturer }],
            pricelists
        );
        const bridgeResult = results[0];

        for (const tier of TIER_NAMES) {
            expect(new Decimal(bridgeResult.prices[tier]).toFixed(2)).toBe(
                new Decimal(workerResult[tier].price).toFixed(2)
            );
        }
    });

    it.each(brands)('%s: desktop app pricingEngine.js (1:1 port) agrees with the Worker engine', (manufacturer) => {
        const row = { code: 'PARITY', price: '100', manufacturer };
        const workerResult = calculateAllTierPrices(row as CsvRow);
        const desktopResult = desktopPricingEngine.calculateAllTierPrices(row, {
            brandLimits: BRAND_LIMITS,
            categoryLimits: {},
            brandSaleDiscounts: BRAND_SALE_DISCOUNTS
        });

        for (const tier of TIER_NAMES) {
            expect(desktopResult[tier].price).toBe(workerResult[tier].price);
        }
    });
});
