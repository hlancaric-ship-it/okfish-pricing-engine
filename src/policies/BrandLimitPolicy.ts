import { PricingPolicy, PricingCommand, RuleType, ReadonlyPricingContext } from '../core/interfaces.js';
import Decimal from 'decimal.js';

export class BrandLimitPolicy implements PricingPolicy {
    name = 'BrandLimit';
    priority = 40;

    constructor(private brandLimits: Record<string, Decimal>) {}

    apply(context: ReadonlyPricingContext): PricingCommand | void {
        if (!context.input.manufacturer) return;
        
        const limit = this.brandLimits[context.input.manufacturer];
        if (!limit) return;

        const one = new Decimal("1");
        const minAllowedPrice = context.input.basePrice.mul(one.minus(limit));

        if (context.currentPrice.lessThan(minAllowedPrice)) {
            return {
                type: "SET_PRICE",
                price: minAllowedPrice,
                rule: RuleType.BRAND_LIMIT,
                metadata: context.input.manufacturer
            };
        }
    }
}
