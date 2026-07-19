import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { EngineBuilder } from '../src/core/EngineBuilder.js';
import { PricingInput, RuleType } from '../src/core/interfaces.js';

describe('PricingEngine Integration', () => {
    it('Golden case: SKU 93682 (Should limit discount to 15%)', () => {
        const engine = EngineBuilder.default().build();
        
        const input: PricingInput = {
            sku: "93682",
            basePrice: new Decimal("14.94"),
            salePrice: new Decimal("12.70"),
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
