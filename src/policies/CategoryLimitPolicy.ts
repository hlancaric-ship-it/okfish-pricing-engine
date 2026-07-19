import { PricingPolicy, PricingCommand, RuleType, ReadonlyPricingContext } from '../core/interfaces.js';
import Decimal from 'decimal.js';

export class CategoryLimitPolicy implements PricingPolicy {
    name = 'CategoryLimit';
    priority = 40;

    constructor(private categoryLimits: Record<string, Decimal>) {}

    apply(context: ReadonlyPricingContext): PricingCommand | void {
        if (!context.input.category) return;
        
        const limit = this.categoryLimits[context.input.category];
        if (!limit) return;

        const one = new Decimal("1");
        const minAllowedPrice = context.input.basePrice.mul(one.minus(limit));

        if (context.currentPrice.lessThan(minAllowedPrice)) {
            return {
                type: "SET_PRICE",
                price: minAllowedPrice,
                rule: RuleType.CATEGORY_LIMIT,
                metadata: context.input.category
            };
        }
    }
}
