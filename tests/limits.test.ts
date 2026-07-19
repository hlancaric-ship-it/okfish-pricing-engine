import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { PricingContext } from '../src/core/PricingContext.js';
import { BrandLimitPolicy } from '../src/policies/BrandLimitPolicy.js';
import { CategoryLimitPolicy } from '../src/policies/CategoryLimitPolicy.js';
import { PricingInput, RuleType } from '../src/core/interfaces.js';

describe('Limits Policies', () => {
    it('BrandLimitPolicy should limit discount based on manufacturer', () => {
        const policy = new BrandLimitPolicy({
            "Apple": new Decimal("0.05") // Max 5% discount
        });
        
        const input: PricingInput = {
            sku: "123",
            basePrice: new Decimal("100"),
            manufacturer: "Apple",
            allowLoyaltyDiscount: true
        };
        const context = new PricingContext(input);
        
        // Mock a previous command that set price to 80 (20% discount)
        context.applyCommand({ type: 'SET_PRICE', price: new Decimal("80"), reason: 'MockSale' });
        
        const command = policy.apply(context);
        if (command) context.applyCommand(command);
        
        // Should limit to 95 (5% discount)
        expect(context.currentPrice.toNumber()).toBe(95);
    });

    it('CategoryLimitPolicy should limit discount based on category', () => {
        const policy = new CategoryLimitPolicy({
            "Electronics": new Decimal("0.10") // Max 10% discount
        });
        
        const input: PricingInput = {
            sku: "123",
            basePrice: new Decimal("100"),
            category: "Electronics",
            allowLoyaltyDiscount: true
        };
        const context = new PricingContext(input);
        
        context.applyCommand({ type: 'SET_PRICE', price: new Decimal("80"), reason: 'MockSale' });
        
        const command = policy.apply(context);
        if (command) context.applyCommand(command);
        
        // Should limit to 90 (10% discount)
        expect(context.currentPrice.toNumber()).toBe(90);
    });
});
