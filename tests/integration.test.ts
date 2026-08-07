import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { EngineBuilder } from '../src/core/EngineBuilder.js';
import { PricingInput, RuleType } from '../src/core/interfaces.js';

describe('PricingEngine Integration', () => {
    it('Golden case: SKU 93682 (Should limit discount to 15%)', () => {
        const engine = EngineBuilder.default().build();
        
        // No salePrice here on purpose -- DiscountLimitPolicy's SALE rule
        // (added after the 2026-08-04 VAGNER incident: an active action price
        // always wins outright over the cap) would otherwise short-circuit
        // and tag this SALE instead of PRODUCT_LIMIT, since the two used to
        // coincidentally compute to the same 12.70. Testing the cap in
        // isolation instead: ZR20's plain 20% loyalty (14.94*0.8=11.95) would
        // undercut the 15% cap floor (14.94*0.85=12.699 -> 12.70), so the cap
        // must clamp it back up to 12.70.
        const input: PricingInput = {
            sku: "93682",
            basePrice: new Decimal("14.94"),
            customerTier: "ZR20", // 20% loyalty
            productMaxDiscount: new Decimal("0.15"),
            allowLoyaltyDiscount: true
        };

        const result = engine.calculatePrice(input);

        // 14.94 * (1 - 0.15) = 12.699 -> 12.70 rounded
        expect(result.finalPrice.toFixed(2)).toBe("12.70");
        expect(result.appliedRules).toEqual(expect.arrayContaining([expect.objectContaining({ rule: RuleType.PRODUCT_LIMIT })]));
    });
});
