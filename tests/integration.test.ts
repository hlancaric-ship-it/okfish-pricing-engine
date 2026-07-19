import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { PricingEngine } from '../src/core/PricingEngine.js';
import { BasePricePolicy } from '../src/policies/BasePricePolicy.js';
import { HighestDiscountPolicy } from '../src/policies/HighestDiscountPolicy.js';
import { ProductMaxDiscountPolicy } from '../src/policies/ProductMaxDiscountPolicy.js';
import { BrandLimitPolicy } from '../src/policies/BrandLimitPolicy.js';
import { CategoryLimitPolicy } from '../src/policies/CategoryLimitPolicy.js';
import { RoundingPolicy } from '../src/policies/RoundingPolicy.js';
import { ValidatorPolicy } from '../src/policies/ValidatorPolicy.js';
import { PricingInput } from '../src/core/interfaces.js';

describe('PricingEngine Integration', () => {
    it('Golden case: SKU 93682 (Should limit discount to 15%)', () => {
        const policies = [
            new BasePricePolicy(),
            new HighestDiscountPolicy(),
            new ProductMaxDiscountPolicy(),
            new BrandLimitPolicy(),
            new CategoryLimitPolicy(),
            new RoundingPolicy(),
            new ValidatorPolicy()
        ];
        
        const engine = new PricingEngine(policies);
        
        const input: PricingInput = {
            sku: "93682",
            basePrice: new Decimal("14.94"),
            salePrice: new Decimal("12.70"),
            customerTier: "ZR20", // 20% loyalty
            productMaxDiscount: new Decimal("0.15"),
            allowLoyaltyDiscount: true
        };
        
        const context = engine.calculatePrice(input);
        
        expect(context.currentPrice.toFixed(2)).toBe("12.70");
    });
});
