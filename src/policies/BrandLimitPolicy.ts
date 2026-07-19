import { PricingPolicy, PricingCommand } from '../core/interfaces.js';

export class BrandLimitPolicy implements PricingPolicy {
    name = 'BrandLimit';
    priority = 40;

    constructor(private brandLimits: Record<string, any>) {}

    apply(context: any): PricingCommand | void {
        if (!context.input.manufacturer) return;
        
        const limit = this.brandLimits[context.input.manufacturer];
        if (!limit) return;

        const one = new (context.input.basePrice.constructor)("1");
        const minAllowedPrice = context.input.basePrice.mul(one.minus(limit));

        if (context.currentPrice.lessThan(minAllowedPrice)) {
            return {
                type: "SET_PRICE",
                price: minAllowedPrice,
                reason: `${this.name} (${context.input.manufacturer})`
            };
        }
    }
}
