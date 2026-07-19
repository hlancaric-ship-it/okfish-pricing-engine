import { PricingPolicy, PricingCommand } from '../core/interfaces.js';

export class BasePricePolicy implements PricingPolicy {
    name = 'BasePrice';
    priority = 10;

    apply(context: any): PricingCommand | void {
        return {
            type: "SET_PRICE",
            price: context.input.basePrice,
            reason: this.name
        };
    }
}
