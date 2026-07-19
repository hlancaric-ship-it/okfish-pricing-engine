import { PricingPolicy, PricingCommand } from '../core/interfaces.js';

export class CategoryLimitPolicy implements PricingPolicy {
    name = 'CategoryLimit';
    priority = 40;

    constructor(private categoryLimits: Record<string, any>) {}

    apply(context: any): PricingCommand | void {
        if (!context.input.category) return;
        
        const limit = this.categoryLimits[context.input.category];
        if (!limit) return;

        const one = new (context.input.basePrice.constructor)("1");
        const minAllowedPrice = context.input.basePrice.mul(one.minus(limit));

        if (context.currentPrice.lessThan(minAllowedPrice)) {
            return {
                type: "SET_PRICE",
                price: minAllowedPrice,
                reason: `${this.name} (${context.input.category})`
            };
        }
    }
}
