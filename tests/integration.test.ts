import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { PricingEngine } from '../src/core/PricingEngine.js';
import { BasePricePolicy } from '../src/policies/BasePricePolicy.js';
import { HighestDiscountPolicy } from '../src/policies/HighestDiscountPolicy.js';
import { ProductMaxDiscountPolicy } from '../src/policies/ProductMaxDiscountPolicy.js';
import { BrandLimitPolicy } from '../src/policies/BrandLimitPolicy.js';
import { CategoryLimitPolicy } from '../src/policies/CategoryLimitPolicy.js';
import { RoundingPolicy } from '../src/policies/RoundingPolicy.js';
import { PricingInput } from '../src/core/interfaces.js';

describe('PricingEngine Integration', () => {
    it('Golden case: SKU 93682 (Should limit discount to 15%)', () => {
        const engine = new PricingEngine();
        engine.use(new BasePricePolicy());
        engine.use(new HighestDiscountPolicy());
        engine.use(new ProductMaxDiscountPolicy());
        engine.use(new BrandLimitPolicy({}));
        engine.use(new CategoryLimitPolicy({}));
        engine.use(new RoundingPolicy());
        
        const input: PricingInput = {
            sku: "93682",
            basePrice: new Decimal("14.94"),
            salePrice: new Decimal("12.70"),
            customerTier: "ZR20", // 20% loyalty
            productMaxDiscount: new Decimal("0.15"),
            allowLoyaltyDiscount: true
        };
        
        const result = engine.calculatePrice(input);
        
        expect(result.finalPrice.toFixed(2)).toBe("12.70");
    });
});
