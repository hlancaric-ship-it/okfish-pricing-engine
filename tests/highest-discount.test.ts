import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { PricingContext } from '../src/core/PricingContext.js';
import { HighestDiscountPolicy } from '../src/policies/HighestDiscountPolicy.js';
import { PricingInput } from '../src/core/interfaces.js';

describe('HighestDiscountPolicy', () => {
    it('Should choose the highest discount between sale and loyalty', () => {
        const policy = new HighestDiscountPolicy();
        
        const input: PricingInput = {
            sku: "123",
            basePrice: new Decimal("100"),
            salePrice: new Decimal("90"), // 10% discount
            customerTier: "ZR20", // 20% discount (80)
            allowLoyaltyDiscount: true
        };
        const context = new PricingContext(input);
        context.currentPrice = input.basePrice;
        
        policy.apply(context);
        
        expect(context.currentPrice.toNumber()).toBe(80);
    });

    it('Should use sale price if loyalty is not allowed', () => {
        const policy = new HighestDiscountPolicy();
        
        const input: PricingInput = {
            sku: "123",
            basePrice: new Decimal("100"),
            salePrice: new Decimal("90"), 
            customerTier: "ZR20",
            allowLoyaltyDiscount: false
        };
        const context = new PricingContext(input);
        context.currentPrice = input.basePrice;
        
        policy.apply(context);
        
        expect(context.currentPrice.toNumber()).toBe(90);
    });
});
