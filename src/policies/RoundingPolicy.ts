import { PricingPolicy, PricingCommand } from '../core/interfaces.js';

export class RoundingPolicy implements PricingPolicy {
    name = 'Rounding';
    priority = 100;

    apply(context: any): PricingCommand | void {
        const rounded = context.currentPrice.toDecimalPlaces(2);
        if (!rounded.equals(context.currentPrice)) {
            return {
                type: "SET_PRICE",
                price: rounded,
                reason: this.name
            };
        }
    }
}
