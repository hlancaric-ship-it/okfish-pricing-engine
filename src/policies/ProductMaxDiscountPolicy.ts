import Decimal from "decimal.js";
import { PricingPolicy, PricingCommand, RuleType, ReadonlyPricingContext } from '../core/interfaces.js';

export class ProductMaxDiscountPolicy implements PricingPolicy {
    name = 'ProductMaxDiscount';
    priority = 30;

    apply(context: ReadonlyPricingContext): PricingCommand | void {
        const limit = context.input.productMaxDiscount;
        if (!limit) return;
        
        if (limit.lessThan(0) || limit.greaterThan(1)) {
            throw new Error(`Invalid maxDiscount ${limit.toString()} for product ${context.input.sku}. Must be between 0 and 1.`);
        }

        const one = new Decimal("1");
        const minAllowedPrice = context.input.basePrice.mul(one.minus(limit));

        if (context.currentPrice.lessThan(minAllowedPrice)) {
            return {
                type: "SET_PRICE",
                price: minAllowedPrice,
                rule: RuleType.PRODUCT_LIMIT
            };
        }
    }
}
