import { PricingPolicy, PricingCommand, RuleType, ReadonlyPricingContext } from '../core/interfaces.js';

export class BasePricePolicy implements PricingPolicy {
    name = 'BasePrice';
    priority = 10;

    apply(context: ReadonlyPricingContext): PricingCommand | void {
        return {
            type: "SET_PRICE",
            price: context.input.basePrice,
            rule: RuleType.BASE_PRICE
        };
    }
}
